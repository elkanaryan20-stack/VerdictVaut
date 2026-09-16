# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

variable "github_repository" {
  description = "\"owner/repo\" - e.g. \"elkanaryan20-stack/VerdictVaut\". No default: this module refuses to trust an unspecified GitHub repository. REQUIRED before this module can even plan."
  type        = string
}

variable "aws_region" {
  description = "Region the ECS clusters/services run in - used only to construct their ARNs deterministically (no data source dependency on either environment's own state). No default - see docs/aws-production-architecture.md §10, REQUIRES HUMAN APPROVAL."
  type        = string
}

variable "environments" {
  description = "Environment names this one shared role may deploy to. Defaults to both - see this module's own header note on why one shared role spans both environments rather than being split per-environment."
  type        = list(string)
  default     = ["staging", "production"]
}

variable "service_names" {
  description = "Short service names, matching environments/*/main.tf's own local.service_names."
  type        = list(string)
  default     = ["web", "api", "worker"]
}

variable "ecr_repository_arns" {
  description = "The 3 verdictvaut-* ECR repository ARNs (module.ecr.repository_arns, same source as modules/iam's execution-role wiring)."
  type        = list(string)
}
