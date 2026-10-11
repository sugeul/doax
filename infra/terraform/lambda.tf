# Registry-API service: one of the global registry's professional services. Runs the Fixed
# Interface HTTP surface (spec §10). Skeleton bundle proves CloudFront -> Lambda -> Aurora/S3.
resource "aws_security_group" "lambda" {
  name   = "${local.name}-lambda"
  vpc_id = data.aws_vpc.default.id

  egress {
    description = "All egress (RDS in-VPC, S3/Logs via VPC endpoints)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "lambda" {
  name = "${local.name}-registry-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_s3" {
  name = "packages-rw"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.packages.arn, "${aws_s3_bucket.packages.arn}/*"]
    }]
  })
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/build/bundle"
  output_path = "${path.module}/build/lambda.zip"
}

resource "aws_lambda_function" "registry" {
  function_name    = "${local.name}-registry"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = var.lambda_memory
  timeout          = var.lambda_timeout

  vpc_config {
    subnet_ids         = data.aws_subnets.default.ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DOAX_DOMAIN          = "https://${var.domain}"
      DOAX_OPERATOR        = var.operator
      DOAX_PACKAGES_BUCKET = aws_s3_bucket.packages.bucket
      DOAX_DB_HOST         = aws_rds_cluster.main.endpoint
      DOAX_DB_PORT         = "5432"
      DOAX_DB_NAME         = aws_rds_cluster.main.database_name
      DOAX_DB_USER         = aws_rds_cluster.main.master_username
      DOAX_DB_PASSWORD     = random_password.db.result
      DOAX_ADMIN_TOKEN     = random_password.admin_token.result
      DOAX_AUDIT_LOG_GROUP = aws_cloudwatch_log_group.audit.name
      DOAX_EMAIL_FROM      = "login@${var.zone}"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.lambda_vpc]
}

# Routed via API Gateway HTTP API (see apigw.tf); the Function URL path was retired after
# its auth layer rejected provably-correct public and OAC-signed invokes on this account.

# Gates publish until the Auth Server issues §7.2 tokens. Read with:
#   terraform output -raw admin_token
resource "random_password" "admin_token" {
  length  = 40
  special = false
}

output "admin_token" {
  value     = random_password.admin_token.result
  sensitive = true
}
