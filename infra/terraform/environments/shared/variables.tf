# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

variable "aws_region" {
  description = "REQUIRES HUMAN APPROVAL — see docs/aws-production-architecture.md §10. No default. Should match staging/production's own region choice — a registry in a different region than the ECS clusters pulling from it adds cross-region data-transfer cost and latency for no benefit."
  type        = string
}

variable "github_repository" {
  description = "Phase 28. \"owner/repo\" of this codebase, e.g. \"elkanaryan20-stack/VerdictVaut\" — the GitHub Actions OIDC trust policy is restricted to exactly this repository. No default: this repository name must be an explicit, conscious choice, not guessed."
  type        = string
}
