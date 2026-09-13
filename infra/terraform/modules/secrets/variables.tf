# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be exactly \"staging\" or \"production\"."
  }
}

variable "secret_names" {
  description = <<-EOT
    Short logical names for the secret OBJECTS to create — e.g.
    ["jwt-access-secret", "jwt-refresh-secret", "postmark-server-token",
    "fireblocks-credentials", "fireblocks-webhook-public-key",
    "elliptic-credentials"]. See docs/aws-iam-and-secrets.md §3 for the
    full inventory and which ECS task role reads each one.

    DATABASE_URL is deliberately NOT included here — it is created by
    modules/database itself (see that module's own secret and its
    "credential design note" in modules/database/main.tf for why),
    output as modules/database's own `database_url_secret_arn`.
  EOT
  type = list(string)
}

variable "recovery_window_days" {
  description = "Secrets Manager's built-in recovery window before a deleted secret is permanently purged (7-30 days per AWS's own valid range). Real, per-environment-variable-driven safety mechanism — see infra/terraform/README.md for why this is used instead of Terraform's own prevent_destroy (which cannot be parameterized by a variable)."
  type        = number
  default     = 30
}
