# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Same S3 bucket as staging, but a DISTINCT state key — this is what
# makes it structurally impossible for a staging `apply` to ever touch
# production state (and vice versa). EXAMPLE ONLY — neither the bucket
# nor the table exists.

terraform {
  backend "s3" {
    bucket         = "verdictvaut-terraform-state" # EXAMPLE ONLY — does not exist
    key            = "production/terraform.tfstate" # separate key from staging
    region         = "us-east-1"                    # EXAMPLE ONLY — see docs/aws-production-architecture.md §10
    dynamodb_table = "verdictvaut-terraform-locks"   # EXAMPLE ONLY — does not exist
    encrypt        = true
  }
}
