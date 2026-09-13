# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be exactly \"staging\" or \"production\"."
  }
}

variable "db_subnet_ids" {
  description = "The 2 isolated database subnet IDs from module.network."
  type        = list(string)
}

variable "vpc_security_group_id" {
  description = "The RDS security group ID from module.network (module.network.rds_security_group_id)."
  type        = string
}

variable "db_name" {
  description = "Initial database name — matches this repository's Prisma schema.prisma datasource, which expects a single database (not a per-tenant/per-schema split)."
  type        = string
  default     = "verdictvaut"
}

variable "instance_class" {
  description = "RDS instance class. No default — must be explicitly chosen per environment; this repository has never measured real load (see docs/aws-disaster-recovery.md §1), so no value is guessed here."
  type        = string
}

variable "allocated_storage_gb" {
  description = "Initial storage, GB. gp3 storage type (see docs/aws-disaster-recovery.md §1)."
  type        = number
  default     = 20
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling — prevents unbounded cost from a leak while avoiding a hard out-of-space outage."
  type        = number
  default     = 100
}

variable "multi_az" {
  description = "true for production (synchronous standby, automated failover). false is acceptable for staging."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "true for production (mandatory — docs/aws-disaster-recovery.md §1). false for staging, so it can actually be torn down."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "PITR retention window. AWS allows 1-35 days; 7 is Phase 25's starting recommendation (docs/aws-disaster-recovery.md §1) pending a real business decision."
  type        = number
  default     = 7
}

variable "backup_window" {
  description = "UTC window, e.g. \"03:00-05:00\" — illustrative default only; the real value should reflect VerdictVaut's actual lowest-traffic period, which this repository has no data on yet."
  type        = string
  default     = "03:00-05:00"
}

variable "maintenance_window" {
  description = "UTC window, e.g. \"sun:05:00-sun:06:00\" — must not overlap backup_window."
  type        = string
  default     = "sun:05:00-sun:06:00"
}

variable "enable_performance_insights" {
  description = "Optional (docs/aws-disaster-recovery.md §1) — native RDS feature, not a third-party vendor."
  type        = bool
  default     = true
}
