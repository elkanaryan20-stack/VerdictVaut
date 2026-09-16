# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Account-level resources shared by staging and production by design —
# today, only the container registry (module.ecr — see its own header
# note for why it is deliberately not duplicated per environment).
# Nothing else belongs here without the same "does this legitimately
# need to be identical across environments" justification; the default
# for any new resource remains a per-environment module, not this one.

module "ecr" {
  source = "../../modules/ecr"

  repository_names = ["web", "api", "worker"]
}

# Phase 28 — closes docs/aws-iam-and-secrets.md §2.5's "Not created or
# used by this phase" gap. See modules/ci-deploy-role/main.tf's own
# header note for why this is account-level (one shared role/OIDC
# provider), not per-environment.
module "ci_deploy_role" {
  source = "../../modules/ci-deploy-role"

  github_repository   = var.github_repository
  aws_region          = var.aws_region
  ecr_repository_arns = values(module.ecr.repository_arns)
}
