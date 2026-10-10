output "registry_url" {
  value = "https://${var.domain}"
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.main.domain_name
}


output "packages_bucket" {
  value = aws_s3_bucket.packages.bucket
}

output "rds_endpoint" {
  value = aws_rds_cluster.main.endpoint
}
