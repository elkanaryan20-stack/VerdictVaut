# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

variable "repository_names" {
  description = "Short names for the ECR repositories to define, e.g. [\"web\", \"api\", \"worker\"] — created as verdictvaut-<name> (docs/aws-deployment-runbook.md §3). No environment segment: this is a single shared registry, see modules/ecr/main.tf's header note."
  type        = list(string)
}

variable "untagged_expiry_days" {
  description = "Days before an untagged (failed/aborted build) image is expired. Illustrative default (docs/aws-deployment-runbook.md §3's \"e.g. 7 days\") — an operational-cost decision, not fixed here."
  type        = number
  default     = 7
}

variable "max_tagged_images" {
  description = "Number of most-recent tagged images retained indefinitely before the oldest are expired. Illustrative default (docs/aws-deployment-runbook.md §3's \"e.g. 50\") — an operational-cost decision, not fixed here."
  type        = number
  default     = 50
}
