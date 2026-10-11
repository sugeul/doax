# The web-app front door (spec decision #4: one hostname, one certificate). Routes the Fixed
# Interface to the registry-API Lambda, and immutable package downloads straight to S3.
resource "aws_cloudfront_response_headers_policy" "packages_cors" {
  name = "${local.name}-packages-cors"
  cors_config {
    access_control_allow_credentials = false
    access_control_allow_origins { items = ["*"] }
    access_control_allow_headers { items = ["*"] }
    access_control_allow_methods { items = ["GET", "HEAD"] }
    access_control_max_age_sec = 86400
    origin_override            = true
  }
}

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${local.name}-s3-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Forward query strings and the Authorization header (the §7.2 bearer token) to API GW;
# never forward Host (API GW routes on its own hostname).
resource "aws_cloudfront_origin_request_policy" "lambda_oac" {
  name = "${local.name}-lambda-oac"
  # cookies must be forwarded or CloudFront strips Set-Cookie from responses (session issuance)
  cookies_config { cookie_behavior = "all" }
  query_strings_config { query_string_behavior = "all" }
  headers_config {
    header_behavior = "allExcept"
    headers { items = ["host"] }
  }
}

locals {
  lambda_origin_host = replace(replace(aws_apigatewayv2_api.registry.api_endpoint, "https://", ""), "/", "")
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  is_ipv6_enabled = true
  aliases         = [var.domain]
  comment         = "doax global registry (skeleton)"
  price_class     = "PriceClass_200"

  origin {
    origin_id   = "lambda"
    domain_name = local.lambda_origin_host
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.packages.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  default_cache_behavior {
    target_origin_id         = "lambda"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.cache_disabled_policy_id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.lambda_oac.id
  }

  ordered_cache_behavior {
    path_pattern           = "/packages/*"
    target_origin_id       = "s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_optimized_policy_id
    # Browser doax-apps fetch packages cross-origin. A STATIC custom header, not the managed
    # CORS policy: CloudFront's conditional CORS logic silently skips ACAO when the request
    # carries the HTTP Priority header (which Chromium always sends on fetch).
    response_headers_policy_id = aws_cloudfront_response_headers_policy.packages_cors.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
