# TENANT — one instantiation per client (decision 140). Each client is a
# separate state: terraform init -backend-config=backend.hcl with
#   key = "usage-component/tenants/<client>.tfstate"
# then apply with -var-file=tenants/<client>.tfvars.
terraform {
  required_version = ">= 1.10"

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
      Layer     = "tenant"
      Tenant    = var.client_name
    }
  }
}

# The foundation's outputs are the contract (its outputs.tf documents them).
data "terraform_remote_state" "foundation" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "usage-component/foundation.tfstate"
    region = var.region
  }
}

locals {
  fdn = data.terraform_remote_state.foundation.outputs

  api_hostname       = "${var.client_name}-api.${local.fdn.base_domain}"
  langwatch_hostname = "${var.client_name}-langwatch.${local.fdn.base_domain}"
  name               = "usage-${var.client_name}"
}
