# Email sign-in (pre-OIDC spec delta): SES sends the login codes.
# Domain identity verifies via DKIM DNS alone — no human click, and the account
# already has SES production access, so codes can go to any inbox.
resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.zone
}

resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.zone}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# The registry Lambda lives in a VPC with no NAT; the SES API is reached via PrivateLink.
resource "aws_vpc_endpoint" "email" {
  vpc_id              = data.aws_vpc.default.id
  service_name        = "com.amazonaws.${var.region}.email"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = data.aws_subnets.default.ids
  security_group_ids  = [aws_security_group.vpce.id]
  private_dns_enabled = true
}

resource "aws_iam_role_policy" "lambda_ses" {
  name = "email-login"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendEmail"]
      Resource = [aws_sesv2_email_identity.domain.arn]
    }]
  })
}
