# auth.doax.io — the Google Drive refresh-token mirror (apps/doax-server/src/drive-auth.ts).
# A SEPARATE, NON-VPC Lambda: it needs public egress to accounts.google.com, which the
# VPC-attached registry Lambda does not have (vpc_endpoints.tf). It runs the OAuth consent
# once and renders a copyable refresh token. The OAuth client is read from Secrets Manager
# at runtime; register https://auth.doax.io as a redirect URI on that client in Google Cloud.
#
# Bundle before apply:  bash infra/build-drive-auth.sh

data "aws_secretsmanager_secret" "drive" {
  name = "doax-adapter-google-drive"
}

data "aws_secretsmanager_secret" "onedrive" {
  name = "doax-adapter-onedrive"
}

data "aws_secretsmanager_secret" "gmail" {
  name = "doax-adapter-gmail"
}

resource "aws_iam_role" "drive_auth" {
  name = "${local.name}-drive-auth-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# No VPC access policy: this function is intentionally outside the VPC (public egress to Google).
resource "aws_iam_role_policy_attachment" "drive_auth_basic" {
  role       = aws_iam_role.drive_auth.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "drive_auth_secret" {
  name = "read-drive-oauth-client"
  role = aws_iam_role.drive_auth.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [data.aws_secretsmanager_secret.drive.arn, data.aws_secretsmanager_secret.onedrive.arn, data.aws_secretsmanager_secret.gmail.arn]
    }]
  })
}

data "archive_file" "drive_auth" {
  type        = "zip"
  source_dir  = "${path.module}/build/drive-auth"
  output_path = "${path.module}/build/drive-auth.zip"
}

resource "aws_lambda_function" "drive_auth" {
  function_name    = "${local.name}-drive-auth"
  role             = aws_iam_role.drive_auth.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.drive_auth.output_path
  source_code_hash = data.archive_file.drive_auth.output_base64sha256
  memory_size      = 256
  timeout          = 15

  environment {
    variables = {
      DRIVE_SECRET_ID     = data.aws_secretsmanager_secret.drive.name
      DRIVE_SECRET_REGION = var.region
      DRIVE_REDIRECT_URI  = "https://auth.${var.zone}"
      DRIVE_SCOPE         = "https://www.googleapis.com/auth/drive.readonly"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.drive_auth_basic]
}

# --- API Gateway HTTP API in front of the function (same pattern as the registry) ---

resource "aws_apigatewayv2_api" "drive_auth" {
  name          = "${local.name}-drive-auth"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "drive_auth" {
  api_id                 = aws_apigatewayv2_api.drive_auth.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.drive_auth.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "drive_auth" {
  api_id    = aws_apigatewayv2_api.drive_auth.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.drive_auth.id}"
}

resource "aws_apigatewayv2_stage" "drive_auth" {
  api_id      = aws_apigatewayv2_api.drive_auth.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "drive_auth_apigw" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.drive_auth.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.drive_auth.execution_arn}/*"
}

# --- auth.doax.io certificate (CloudFront certs must live in us-east-1) ---

resource "aws_acm_certificate" "drive_auth" {
  provider          = aws.us_east_1
  domain_name       = "auth.${var.zone}"
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "drive_auth_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.drive_auth.domain_validation_options : dvo.domain_name => {
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

resource "aws_acm_certificate_validation" "drive_auth" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.drive_auth.arn
  validation_record_fqdns = [for r in aws_route53_record.drive_auth_cert_validation : r.fqdn]
}

# --- CloudFront in front of the API (TLS + the auth.doax.io alias) ---

locals {
  drive_auth_origin_host = replace(replace(aws_apigatewayv2_api.drive_auth.api_endpoint, "https://", ""), "/", "")
}

resource "aws_cloudfront_distribution" "drive_auth" {
  enabled         = true
  is_ipv6_enabled = true
  aliases         = ["auth.${var.zone}"]
  comment         = "doax Google Drive refresh-token mirror"
  price_class     = "PriceClass_200"

  origin {
    origin_id   = "lambda"
    domain_name = local.drive_auth_origin_host
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "lambda"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_disabled_policy_id
    # Forwards query (?code/?state) and cookies (the state cookie), never Host — API GW routes on its own.
    origin_request_policy_id = aws_cloudfront_origin_request_policy.lambda_oac.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.drive_auth.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "drive_auth_a" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "auth.${var.zone}"
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.drive_auth.domain_name
    zone_id                = aws_cloudfront_distribution.drive_auth.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "drive_auth_aaaa" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "auth.${var.zone}"
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.drive_auth.domain_name
    zone_id                = aws_cloudfront_distribution.drive_auth.hosted_zone_id
    evaluate_target_health = false
  }
}

output "drive_auth_url" { value = "https://auth.${var.zone}" }
