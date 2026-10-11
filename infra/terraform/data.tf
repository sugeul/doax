data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# Skeleton uses the account's default VPC so no custom network has to be stood up.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_route_tables" "default" {
  vpc_id = data.aws_vpc.default.id
}

data "aws_route53_zone" "main" {
  name         = "${var.zone}."
  private_zone = false
}

data "aws_cloudfront_response_headers_policy" "simple_cors" {
  name = "Managed-SimpleCORS"
}
