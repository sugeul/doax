# app.doax.io — the lightweight doax-app provider. Static bundles only; an app consumes doax
# resources through the Fixed Interface, and deploying one is a registry operation gated by
# the same namespace roles as publish. Subdomain-per-namespace: https://<ns>.app.doax.io/
# serves the namespace's app — each app gets its own browser origin, so apps can never read
# each other's storage or future client-side tokens.
resource "aws_s3_bucket" "apps" {
  bucket        = "${var.project}-apps-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "apps" {
  bucket                  = aws_s3_bucket.apps.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The provider landing page at app.doax.io/
resource "aws_s3_object" "apps_landing" {
  bucket        = aws_s3_bucket.apps.id
  key           = "index.html"
  source        = "${path.module}/../apps-landing/index.html"
  etag          = filemd5("${path.module}/../apps-landing/index.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "public, max-age=300"
}

resource "aws_cloudfront_origin_access_control" "apps" {
  name                              = "${local.name}-apps-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "apps_router" {
  name    = "${local.name}-apps-router"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/edge/apps-router.js")
}

resource "aws_acm_certificate" "apps" {
  provider                  = aws.us_east_1
  domain_name               = "app.${var.zone}"
  subject_alternative_names = ["*.app.${var.zone}"]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "apps_cert_validation" {
  # apex and wildcard share one validation record; allow_overwrite handles the duplicate
  for_each = {
    for dvo in aws_acm_certificate.apps.domain_validation_options : dvo.domain_name => {
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

resource "aws_acm_certificate_validation" "apps" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.apps.arn
  validation_record_fqdns = [for r in aws_route53_record.apps_cert_validation : r.fqdn]
}

resource "aws_cloudfront_distribution" "apps" {
  enabled             = true
  is_ipv6_enabled     = true
  aliases             = ["app.${var.zone}", "*.app.${var.zone}"]
  comment             = "doax app provider (static doax-apps)"
  price_class         = "PriceClass_200"
  default_root_object = "index.html"

  origin {
    origin_id                = "apps"
    domain_name              = aws_s3_bucket.apps.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.apps.id
  }

  default_cache_behavior {
    target_origin_id       = "apps"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_optimized_policy_id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.apps_router.arn
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.apps.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_s3_bucket_policy" "apps" {
  bucket = aws_s3_bucket.apps.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.apps.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.apps.arn } }
    }]
  })
}

resource "aws_route53_record" "apps_a" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "app.${var.zone}"
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.apps.domain_name
    zone_id                = aws_cloudfront_distribution.apps.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "apps_aaaa" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "app.${var.zone}"
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.apps.domain_name
    zone_id                = aws_cloudfront_distribution.apps.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_iam_role_policy" "lambda_apps" {
  name = "apps-deploy"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.apps.arn, "${aws_s3_bucket.apps.arn}/*"]
    }]
  })
}

resource "aws_route53_record" "apps_wildcard_a" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "*.app.${var.zone}"
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.apps.domain_name
    zone_id                = aws_cloudfront_distribution.apps.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "apps_wildcard_aaaa" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "*.app.${var.zone}"
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.apps.domain_name
    zone_id                = aws_cloudfront_distribution.apps.hosted_zone_id
    evaluate_target_health = false
  }
}

output "app_provider_url" { value = "https://app.${var.zone}" }
