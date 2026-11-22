# MCP Gateway (mcp.doax.io): the per-registry MCP-over-HTTP webapp. A stateless proxy to the registry
# (apps/mcp-gateway), so unlike the registry Lambda it needs no VPC — it reaches registry.doax.io over
# the internet and forwards the caller's doax bearer. API Gateway HTTP API on a regional custom domain.

resource "aws_iam_role" "mcp" {
  name = "${local.name}-mcp-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "mcp_logs" {
  role       = aws_iam_role.mcp.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "archive_file" "mcp" {
  type        = "zip"
  source_dir  = "${path.module}/build/mcp-bundle"
  output_path = "${path.module}/build/mcp-lambda.zip"
}

resource "aws_lambda_function" "mcp" {
  function_name    = "${local.name}-mcp"
  role             = aws_iam_role.mcp.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.mcp.output_path
  source_code_hash = data.archive_file.mcp.output_base64sha256
  memory_size      = var.lambda_memory
  timeout          = var.lambda_timeout

  environment {
    variables = {
      DOAX_REGISTRY = "https://registry.${var.zone}"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.mcp_logs]
}

resource "aws_apigatewayv2_api" "mcp" {
  name          = "${local.name}-mcp"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "mcp" {
  api_id                 = aws_apigatewayv2_api.mcp.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.mcp.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "mcp_default" {
  api_id    = aws_apigatewayv2_api.mcp.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.mcp.id}"
}

resource "aws_apigatewayv2_stage" "mcp_default" {
  api_id      = aws_apigatewayv2_api.mcp.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "mcp_apigw" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.mcp.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.mcp.execution_arn}/*"
}

# A regional certificate (same region as the HTTP API) for the custom domain.
resource "aws_acm_certificate" "mcp" {
  domain_name       = "mcp.${var.zone}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "mcp_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.mcp.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "mcp" {
  certificate_arn         = aws_acm_certificate.mcp.arn
  validation_record_fqdns = [for r in aws_route53_record.mcp_cert_validation : r.fqdn]
}

resource "aws_apigatewayv2_domain_name" "mcp" {
  domain_name = "mcp.${var.zone}"

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.mcp.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "mcp" {
  api_id      = aws_apigatewayv2_api.mcp.id
  domain_name = aws_apigatewayv2_domain_name.mcp.id
  stage       = aws_apigatewayv2_stage.mcp_default.id
}

resource "aws_route53_record" "mcp" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "mcp.${var.zone}"
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.mcp.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.mcp.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

output "mcp_url" {
  value = "https://mcp.${var.zone}"
}
