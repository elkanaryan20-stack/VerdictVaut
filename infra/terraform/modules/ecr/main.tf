# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Phase 27 addition — was previously entirely absent from the Terraform
# tree even though docs/aws-deployment-runbook.md §3 has specified this
# exact configuration (immutable tags, scan-on-push, lifecycle policy)
# since Phase 25. This module defines the 3 verdictvaut-* repositories
# so that, once a human authorizes a real `terraform apply`, they come
# into existence already hardened — it does not create anything itself
# (no `terraform apply` is run by this phase; per this phase's brief,
# repositories are not created now).
#
# DELIBERATELY NOT per-environment: docs/aws-deployment-runbook.md §3
# names these repositories "verdictvaut-web"/"-api"/"-worker" (no
# staging/production suffix) because §4.2's pipeline is a build-once,
# promote model — the exact image (same commit-SHA tag, same registry)
# that passes staging validation is what production later deploys, not
# a separately-built image with a coincidentally-matching tag. A
# per-environment repository pair would break that guarantee (nothing
# would stop the two repos' contents from silently diverging for the
# "same" tag). This is therefore a single shared registry, instantiated
# once by environments/shared/main.tf — never by environments/staging
# or environments/production directly — even though staging and
# production remain hard-isolated everywhere else (network, database,
# secrets, state: see docs/aws-terraform-security-review.md §1's
# "share no state, network, database, or secret namespace" finding,
# which this module does not contradict — a container registry is a
# distribution artifact store, not application state or a credential).

locals {
  name_prefix = "verdictvaut"
}

resource "aws_ecr_repository" "this" {
  for_each = toset(var.repository_names)

  name = "${local.name_prefix}-${each.value}"

  # A tag, once pushed, can never be overwritten — this is what makes
  # "redeploy the previous commit-SHA tag" an unambiguous rollback
  # (docs/aws-deployment-runbook.md §3), never a since-changed image
  # quietly substituted underneath the same tag.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256" # AWS-managed key — see docs/aws-terraform-security-review.md F4 for the customer-managed-KMS tradeoff, not adopted here for the same reason as Secrets Manager/CloudWatch
  }

  tags = {
    Name      = "${local.name_prefix}-${each.value}"
    ManagedBy = "terraform"
    Project   = "verdictvaut"
  }
}

# Expires untagged images quickly (cleans up failed/aborted build
# artifacts) and caps the number of tagged images retained — exact
# numbers are an operational-cost tradeoff (docs/aws-cost-governance.md
# §2's ECR row), configurable per environment, not hardcoded here.
resource "aws_ecr_lifecycle_policy" "this" {
  for_each = toset(var.repository_names)

  repository = aws_ecr_repository.this[each.value].name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after ${var.untagged_expiry_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_expiry_days
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the most recent ${var.max_tagged_images} tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = var.max_tagged_images
        }
        action = { type = "expire" }
      }
    ]
  })
}
