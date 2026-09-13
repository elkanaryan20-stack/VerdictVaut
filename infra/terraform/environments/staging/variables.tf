# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
# No default is set for any value that would otherwise require
# inventing a real AWS identifier (region, account, image tags,
# domain) — every one of these must be supplied explicitly via
# terraform.tfvars (see terraform.tfvars.example), never hardcoded
# here, and none is set by this phase.

variable "aws_region" {
  description = "REQUIRES HUMAN APPROVAL — see docs/aws-production-architecture.md §10. No default."
  type        = string
}

variable "availability_zones" {
  type = list(string)
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16" # EXAMPLE ONLY — see docs/aws-network-design.md §1
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "app_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "db_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.20.0/24", "10.0.21.0/24"]
}

variable "db_instance_class" {
  description = "No default — see docs/aws-disaster-recovery.md §1 (no load test has ever been run against this schema)."
  type        = string
}

variable "web_image" {
  description = "Full ECR image URI:tag for verdictvaut-web. No default — no image has ever been pushed to any registry by this repository's history."
  type        = string
}

variable "api_image" {
  type = string
}

variable "worker_image" {
  type = string
}

variable "cors_allowed_origins" {
  description = "Staging's real origin(s) — no default, must be explicit (docs/production-readiness-check.js already treats an empty value in production as a likely misconfiguration; the same reasoning applies here)."
  type        = string
}

variable "email_base_url" {
  type = string
}

variable "email_from_address" {
  type = string
}

variable "certificate_arn" {
  description = "Pre-existing/validated ACM certificate ARN for staging's domain. No default — no domain has been chosen (docs/aws-production-architecture.md §10)."
  type        = string
  default     = null
}
