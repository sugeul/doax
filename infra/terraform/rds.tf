# System-of-record DB (the user's "mem db"): Aurora PostgreSQL Serverless v2.
# Skeleton connects Lambda straight to the cluster endpoint; production should front it with
# RDS Proxy (Lambda connection pooling) and move credentials into Secrets Manager with rotation.
resource "random_password" "db" {
  length  = 24
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_security_group" "rds" {
  name   = "${local.name}-rds"
  vpc_id = data.aws_vpc.default.id

  ingress {
    description     = "Postgres from the registry Lambda"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }
}

resource "aws_rds_cluster" "main" {
  cluster_identifier     = "${local.name}-pg"
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"
  database_name          = "doax"
  master_username        = "doax"
  master_password        = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  storage_encrypted      = true
  skip_final_snapshot    = true
  apply_immediately      = true

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 2
  }
}

resource "aws_rds_cluster_instance" "main" {
  identifier          = "${local.name}-pg-1"
  cluster_identifier  = aws_rds_cluster.main.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version
  publicly_accessible = false
}
