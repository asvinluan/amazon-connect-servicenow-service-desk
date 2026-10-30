terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Pinned. An unpinned provider upgrade is an unreviewed change.
      version = "~> 5.80"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Local state is fine for a lab. For anything shared, use an S3 backend with
  # DynamoDB locking and KMS encryption, because state holds resource identifiers.
  #
  # backend "s3" {
  #   bucket         = "CHANGEME-tfstate"
  #   key            = "connect/service-desk/terraform.tfstate"
  #   region         = "ap-southeast-2"
  #   dynamodb_table = "CHANGEME-tflock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "amazon-connect-servicenow-service-desk"
      Environment = "lab"
      ManagedBy   = "terraform"
      Repo        = "amazon-connect-servicenow-service-desk"
    }
  }
}
