# Audit store (spec §8): CloudWatch Logs. Append-only by construction — individual log events
# cannot be edited or deleted — and retained forever (retention_in_days = 0).
resource "aws_cloudwatch_log_group" "audit" {
  name              = "/doax/audit"
  retention_in_days = 0
}

resource "aws_iam_role_policy" "lambda_audit" {
  name = "audit-rw"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:FilterLogEvents", "logs:DescribeLogStreams"]
        Resource = ["${aws_cloudwatch_log_group.audit.arn}", "${aws_cloudwatch_log_group.audit.arn}:*"]
      }
    ]
  })
}
