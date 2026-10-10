resource "aws_cloudfront_function" "cors" {
  name    = "${local.name}-cors"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/edge/cors.js")
}
