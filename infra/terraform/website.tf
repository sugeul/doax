# The human website at the apex (doax.io) — the npm model: registry.* is the API, the apex is
# the site. Static HTML on S3, served via its own CloudFront distribution + OAC.
resource "aws_s3_bucket" "site" {
  bucket        = "${var.project}-site-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "index" {
  bucket        = aws_s3_bucket.site.id
  key           = "index.html"
  source        = "${path.module}/build/site/index.html"
  etag          = filemd5("${path.module}/build/site/index.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "public, max-age=300"
}

# AYA agent-first onboarding (https://askyouragent.sh), served at https://doax.io/aya.html
resource "aws_s3_object" "aya" {
  bucket        = aws_s3_bucket.site.id
  key           = "aya.html"
  source        = "${path.module}/../site/aya.html"
  etag          = filemd5("${path.module}/../site/aya.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "public, max-age=300"
}

# The playbooks (local / cowork / monitor app shapes). One .html object per page; the clean
# permalink (/playbook/<category>/<situation>, no extension) resolves to it via the site-router
# CloudFront Function below. Built by infra/build-playbook.mjs into build/site/playbook*.
locals {
  playbook_pages = toset(concat(
    [for f in fileset("${path.module}/build/site", "playbook*") : f], # /playbook.html
    [for f in fileset("${path.module}/build/site", "playbook/**") : f],
  ))
}

resource "aws_s3_object" "playbook" {
  for_each      = local.playbook_pages
  bucket        = aws_s3_bucket.site.id
  key           = each.value
  source        = "${path.module}/build/site/${each.value}"
  etag          = filemd5("${path.module}/build/site/${each.value}")
  content_type  = "text/html; charset=utf-8"
  cache_control = "public, max-age=300"
}

# Clean URLs for /playbook/*: extensionless requests resolve to the .html object. Scoped to
# /playbook so existing extensionless objects (/install, ...) are untouched.
resource "aws_cloudfront_function" "site_router" {
  name    = "${local.name}-site-router"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/edge/site-router.js")
}

# The CLI install guide, served at https://doax.io/install
resource "aws_s3_object" "install_page" {
  bucket        = aws_s3_bucket.site.id
  key           = "install"
  source        = "${path.module}/build/site/install.html"
  etag          = filemd5("${path.module}/build/site/install.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "public, max-age=300"
}

# The one-liner installer: curl -fsSL https://doax.io/install.sh | bash
resource "aws_s3_object" "install_sh" {
  bucket        = aws_s3_bucket.site.id
  key           = "install.sh"
  source        = "${path.module}/build/site/install.sh"
  etag          = filemd5("${path.module}/build/site/install.sh")
  content_type  = "text/x-shellscript; charset=utf-8"
  cache_control = "public, max-age=300"
}

# The Windows installer: irm https://doax.io/install.ps1 | iex
resource "aws_s3_object" "install_ps1" {
  bucket        = aws_s3_bucket.site.id
  key           = "install.ps1"
  source        = "${path.module}/build/site/install.ps1"
  etag          = filemd5("${path.module}/build/site/install.ps1")
  content_type  = "text/plain; charset=utf-8"
  cache_control = "public, max-age=300"
}

# The Windows launcher that install.ps1 downloads into ~\.doax\bin
resource "aws_s3_object" "doax_ps1" {
  bucket        = aws_s3_bucket.site.id
  key           = "doax.ps1"
  source        = "${path.module}/build/site/doax.ps1"
  etag          = filemd5("${path.module}/build/site/doax.ps1")
  content_type  = "text/plain; charset=utf-8"
  cache_control = "public, max-age=300"
}

# The CLI itself: one self-contained ESM bundle (Node >= 20)
resource "aws_s3_object" "cli_bundle" {
  bucket        = aws_s3_bucket.site.id
  key           = "cli/doax.mjs"
  source        = "${path.module}/build/site/cli/doax.mjs"
  etag          = filemd5("${path.module}/build/site/cli/doax.mjs")
  content_type  = "text/javascript; charset=utf-8"
  cache_control = "public, max-age=300"
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.name}-site-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_acm_certificate" "site" {
  provider          = aws.us_east_1
  domain_name       = var.zone
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "site_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.site.domain_validation_options : dvo.domain_name => {
      name = dvo.resource_record_name, record = dvo.resource_record_value, type = dvo.resource_record_type
    }
  }
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.site_cert_validation : r.fqdn]
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  aliases             = [var.zone]
  comment             = "doax website (apex)"
  price_class         = "PriceClass_200"
  default_root_object = "index.html"

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_optimized_policy_id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_router.arn
    }
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
    }]
  })
}

resource "aws_route53_record" "site_a" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.zone
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_aaaa" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.zone
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

output "site_url" { value = "https://${var.zone}" }
output "site_cloudfront_domain" { value = aws_cloudfront_distribution.site.domain_name }
