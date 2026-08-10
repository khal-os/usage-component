# Foundation — built ONCE, shared by every tenant (decision 140).
# State lives in S3: `terraform init -backend-config=backend.hcl`
# (see backend.hcl.example; the bucket is bootstrapped by hand, README §1).
terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "usage-component"
      ManagedBy = "terraform"
      Layer     = "foundation"
    }
  }
}
