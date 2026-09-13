# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

variable "environment" {
  description = "Short environment name (e.g. \"staging\", \"production\") — used only in resource Name tags, never in a hardcoded resource identifier."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be exactly \"staging\" or \"production\" — no other environment is designed by this module."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. See docs/aws-network-design.md §1 for the EXAMPLE ONLY value used to illustrate this design (10.0.0.0/16) — the real value is a per-account decision, not fixed here."
  type        = string
}

variable "availability_zones" {
  description = "Exactly 2 AZ names in the chosen region (e.g. [\"us-east-1a\", \"us-east-1b\"] — EXAMPLE ONLY, see docs/aws-production-architecture.md §10 for the region decision, which is REQUIRES HUMAN APPROVAL)."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "Exactly 2 availability zones are required — matches RDS Multi-AZ's own 2-AZ model and this module's subnet math."
  }
}

variable "public_subnet_cidrs" {
  description = "2 CIDRs, one per AZ, for the public (ALB/NAT) tier."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_cidrs) == 2
    error_message = "Exactly 2 public subnet CIDRs are required (one per AZ)."
  }
}

variable "app_subnet_cidrs" {
  description = "2 CIDRs, one per AZ, for the private application (ECS) tier."
  type        = list(string)

  validation {
    condition     = length(var.app_subnet_cidrs) == 2
    error_message = "Exactly 2 application subnet CIDRs are required (one per AZ)."
  }
}

variable "db_subnet_cidrs" {
  description = "2 CIDRs, one per AZ, for the isolated database tier — never routed to the internet, see docs/aws-network-design.md §2."
  type        = list(string)

  validation {
    condition     = length(var.db_subnet_cidrs) == 2
    error_message = "Exactly 2 database subnet CIDRs are required (one per AZ)."
  }
}

variable "nat_gateway_per_az" {
  description = "true = one NAT gateway per AZ (production — see docs/aws-network-design.md §4 for why a shared NAT would undermine the Multi-AZ design). false = a single shared NAT gateway (staging — acceptable cost/availability tradeoff for a non-production environment)."
  type        = bool
  default     = false
}
