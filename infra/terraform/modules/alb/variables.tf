# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Implements docs/aws-deployment-runbook.md §2: HTTPS (443) + HTTP->HTTPS
# redirect (80) listeners, host/path-based routing to web vs. API target
# groups, and (optionally) an ACM certificate created + DNS-validated
# against a Route 53 hosted zone this module does NOT assume exists.

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be exactly \"staging\" or \"production\"."
  }
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "enable_deletion_protection" {
  description = "true for production (prevents an accidental console/API/terraform destroy of the public ALB). false for staging, so it can actually be torn down. No default, deliberately — same reasoning as modules/database's deletion_protection (docs/aws-terraform-security-review.md F2): a safety-critical flag should force every caller to make an explicit, conscious choice."
  type        = bool
}

variable "create_certificate" {
  description = "true: this module creates + DNS-validates an ACM certificate (requires domain_name and route53_zone_id). false: certificate_arn must be supplied directly (e.g. a cert created/validated outside Terraform). Neither path is exercised by this phase — no domain has been chosen (docs/aws-production-architecture.md §10, REQUIRES HUMAN APPROVAL)."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "e.g. \"app.example.com\" — EXAMPLE ONLY shape, no real value set by this phase. Required if create_certificate = true."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Existing Route 53 hosted zone ID for DNS validation. Required if create_certificate = true. Not created by this module — Route 53 zone/domain ownership is a separate, human decision."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "Pre-existing/validated ACM certificate ARN. Required if create_certificate = false. No real value set by this phase."
  type        = string
  default     = null
}

variable "api_host_header" {
  description = "Host header used to route to the API target group, e.g. \"api.example.com\" (docs/aws-deployment-runbook.md §2 — host-based routing option). If null, path-based routing (api_path_patterns) is used instead."
  type        = string
  default     = null
}

variable "api_path_patterns" {
  description = "Path patterns routed to the API target group when api_host_header is null, e.g. [\"/api/*\", \"/webhooks/*\", \"/health*\"]."
  type        = list(string)
  default     = ["/api/*", "/webhooks/*"]
}
