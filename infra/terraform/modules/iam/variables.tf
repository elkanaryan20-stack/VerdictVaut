# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Implements docs/aws-iam-and-secrets.md §2. No AdministratorAccess or
# other AWS-managed broad policy is attached anywhere in this module —
# every permission below was derived from reading this repository's
# actual application code (zero @aws-sdk/* usage anywhere, re-verified
# repeatedly across Phases 23-25), not copied from a generic template.

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be exactly \"staging\" or \"production\"."
  }
}

variable "task_role_names" {
  description = "Short names for the per-service task roles to create, e.g. [\"web\", \"api\", \"worker\"] — see docs/aws-iam-and-secrets.md §2.2-§2.4. Each starts with zero attached permissions beyond the ECS trust policy; this module does not guess future permissions."
  type        = list(string)
}

variable "ecr_repository_arns" {
  description = "ARNs of the 3 verdictvaut-* ECR repositories the execution role may pull from (docs/aws-iam-and-secrets.md §2.1). No repository exists yet (§ docs/aws-deployment-runbook.md §3 — \"Do not create repositories yet\") — this module does not create them either; pass [] until they exist, in which case the execution role's ECR pull statement is scoped to nothing (an empty resource list is intentionally restrictive, not a wildcard fallback)."
  type        = list(string)
  default     = []
}

variable "log_group_arns" {
  description = "ARNs of the /ecs/verdictvaut-<environment>-* CloudWatch log groups (module.observability output, with :* appended for the log-stream level) the execution role may write to."
  type        = list(string)
  default     = []
}

variable "secret_arns" {
  description = "ARNs of the Secrets Manager secrets (module.secrets output, plus module.database's composed database_url_secret_arn) the execution role may read to inject into containers."
  type        = list(string)
  default     = []
}
