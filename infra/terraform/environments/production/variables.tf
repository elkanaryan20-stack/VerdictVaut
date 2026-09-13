# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
# Same shape as environments/staging/variables.tf — no default is set
# for any value that would otherwise require inventing a real AWS
# identifier. See that file's comments; not re-duplicated here.

variable "aws_region" {
  description = "REQUIRES HUMAN APPROVAL — see docs/aws-production-architecture.md §10. No default."
  type        = string
}

variable "availability_zones" {
  type = list(string)
}

variable "vpc_cidr" {
  type    = string
  default = "10.1.0.0/16" # EXAMPLE ONLY — distinct from staging's 10.0.0.0/16, so the two could later be VPC-peered without a CIDR collision if ever needed
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.1.0.0/24", "10.1.1.0/24"]
}

variable "app_subnet_cidrs" {
  type    = list(string)
  default = ["10.1.10.0/24", "10.1.11.0/24"]
}

variable "db_subnet_cidrs" {
  type    = list(string)
  default = ["10.1.20.0/24", "10.1.21.0/24"]
}

variable "db_instance_class" {
  description = "No default — see docs/aws-disaster-recovery.md §1 (no load test has ever been run against this schema). Must be a real, deliberate sizing decision, not staging's value reused blindly."
  type        = string
}

variable "web_image" {
  type = string
}

variable "api_image" {
  type = string
}

variable "worker_image" {
  type = string
}

variable "cors_allowed_origins" {
  type = string
}

variable "email_base_url" {
  type = string
}

variable "email_from_address" {
  description = "Must be on a domain with verified SPF/DKIM in Postmark before EMAIL_PROVIDER=postmark can actually work in production (docs/aws-production-architecture.md §12) — not verified or configured by this phase."
  type        = string
}

variable "certificate_arn" {
  type    = string
  default = null
}
