# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

variable "aws_region" {
  description = "REQUIRES HUMAN APPROVAL — see docs/aws-production-architecture.md §10. No default. Should match staging/production's own region choice — a registry in a different region than the ECS clusters pulling from it adds cross-region data-transfer cost and latency for no benefit."
  type        = string
}
