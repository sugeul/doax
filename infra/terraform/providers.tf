# The global registry runs in one home region; CloudFront certs and functions must live in us-east-1.
provider "aws" {
  region  = var.region
  profile = var.profile
  default_tags { tags = local.tags }
}

provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.profile
  default_tags { tags = local.tags }
}
