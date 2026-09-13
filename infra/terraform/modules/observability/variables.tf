# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be exactly \"staging\" or \"production\"."
  }
}

variable "service_names" {
  description = "Short service names, e.g. [\"web\", \"api\", \"worker\"] — one CloudWatch log group per entry, named /ecs/verdictvaut-<environment>-<name>."
  type        = list(string)
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention. No cost/compliance decision is made here — 30 is a reasonable, unverified default."
  type        = number
  default     = 30
}
