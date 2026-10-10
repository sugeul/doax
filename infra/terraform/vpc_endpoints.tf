# A VPC Lambda has no public egress, so S3 and CloudWatch Logs are reached via endpoints.
resource "aws_security_group" "vpce" {
  name   = "${local.name}-vpce"
  vpc_id = data.aws_vpc.default.id

  ingress {
    description     = "HTTPS from the registry Lambda"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = data.aws_vpc.default.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = data.aws_route_tables.default.ids
}

resource "aws_vpc_endpoint" "logs" {
  vpc_id              = data.aws_vpc.default.id
  service_name        = "com.amazonaws.${var.region}.logs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = data.aws_subnets.default.ids
  security_group_ids  = [aws_security_group.vpce.id]
  private_dns_enabled = true
}
