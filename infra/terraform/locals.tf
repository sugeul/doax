locals {
  name   = var.project
  bucket = "${var.project}-packages-${data.aws_caller_identity.current.account_id}"
  tags = {
    project   = var.project
    managedby = "terraform"
    stack     = "global-registry-skeleton"
  }

  # AWS-managed CloudFront policy ids (stable, documented).
  cache_disabled_policy_id   = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  cache_optimized_policy_id  = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  origin_req_all_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
}
