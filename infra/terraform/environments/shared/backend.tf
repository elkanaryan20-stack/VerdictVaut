# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Same S3 bucket as staging/production, a THIRD distinct state key —
# holds only account-level resources that legitimately cross the
# staging/production boundary by design (today: the shared ECR
# registry, see modules/ecr/main.tf's header note on why it must not be
# duplicated per environment). EXAMPLE ONLY — neither the bucket nor
# the table exists. Never uncomment/run this against a real bucket
# without the same bootstrap step README.md describes for staging/
# production.

terraform {
  backend "s3" {
    bucket         = "verdictvaut-terraform-state" # EXAMPLE ONLY — does not exist
    key            = "shared/terraform.tfstate"    # separate key from staging AND production
    region         = "us-east-1"                   # EXAMPLE ONLY — see docs/aws-production-architecture.md §10
    dynamodb_table = "verdictvaut-terraform-locks"  # EXAMPLE ONLY — does not exist
    encrypt        = true
  }
}
