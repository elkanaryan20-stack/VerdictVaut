# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# S3 + DynamoDB remote state, per infra/terraform/README.md's "State
# storage and locking design". The bucket/table below are EXAMPLE ONLY
# names — neither exists; both would need to be created once, manually
# or via a small separate bootstrap config with local state, before
# `terraform init` could succeed here for real. Never uncomment/run
# this against a real bucket without that bootstrap step done first.

terraform {
  backend "s3" {
    bucket         = "verdictvaut-terraform-state" # EXAMPLE ONLY — does not exist
    key            = "staging/terraform.tfstate"   # separate key from production — see README
    region         = "us-east-1"                   # EXAMPLE ONLY — see docs/aws-production-architecture.md §10
    dynamodb_table = "verdictvaut-terraform-locks"  # EXAMPLE ONLY — does not exist
    encrypt        = true
  }
}
