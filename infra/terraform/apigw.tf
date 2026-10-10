# API Gateway HTTP API between CloudFront and the registry Lambda. The Function URL +
# OAC(AWS_IAM) path was abandoned: with provably per-docs config (manual SigV4 → 200), the
# URL auth layer still rejected both anonymous (authType NONE + public policy) and
# CloudFront-OAC-signed invokes on this account. HTTP API payload v2.0 keeps the same event
# shape, so the handler is unchanged.
resource "aws_apigatewayv2_api" "registry" {
  name          = "${local.name}-registry"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "registry" {
  api_id                 = aws_apigatewayv2_api.registry.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.registry.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.registry.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.registry.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.registry.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.registry.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.registry.execution_arn}/*"
}

output "apigw_endpoint" {
  value = aws_apigatewayv2_api.registry.api_endpoint
}
