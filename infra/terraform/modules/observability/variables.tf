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

# --- Phase 28: alarms, closing the gap docs/aws-production-architecture.md
# §13/§14 specified but no prior phase implemented in Terraform. Every
# log-based filter pattern below matches the REAL JSON shape
# JsonLoggerService/LoggingMetricsService emit today (re-read this
# phase — apps/api/src/observability/json-logger.service.ts,
# metrics.service.ts) and every metric NAME matches a real
# `metrics.increment(...)` call site grepped this phase — none is
# invented. "Do not create noisy alarms" (this phase's own brief): every
# threshold below requires either a sustained/elevated rate (errors,
# 5xx) or is a genuinely rare event where even a single occurrence is
# actionable (a CRITICAL reconciliation discrepancy, a custody/
# compliance provider failure, an unhealthy ALB target) — never
# "alarm on every single log line."

variable "alarm_topic_subscription_emails" {
  description = "Optional list of email addresses to subscribe to the SNS alerts topic (aws_sns_topic_subscription, protocol=email — each address must still confirm the subscription itself, exactly like any other SNS email subscription). Defaults to empty: this phase creates the topic and every alarm/event source that publishes to it, but sets no real notification endpoint out-of-band, matching this repository's standing 'Terraform creates objects, a human wires the real destination' pattern (see modules/secrets' own header note) — a human operator adds the real on-call address(es) here (or an equivalent PagerDuty/Slack SNS integration, not designed here) once one is authorized."
  type        = list(string)
  default     = []
}

variable "rds_db_instance_id" {
  description = "The RDS instance identifier (module.database.db_instance_identifier), or null to skip creating the aws_db_event_subscription entirely. Null is the correct value for any environment/plan that does not yet instantiate module.database — this variable never invents an identifier."
  type        = string
  default     = null
}

variable "alb_arn_suffix" {
  description = "The ALB's arn_suffix (module.alb output, e.g. \"app/verdictvaut-production-alb/...\") for CloudWatch's AWS/ApplicationELB dimensions, or null to skip every ALB-dimensioned alarm."
  type        = string
  default     = null
}

variable "web_target_group_arn_suffix" {
  description = "The web target group's arn_suffix (module.alb output), or null to skip the web unhealthy-host alarm."
  type        = string
  default     = null
}

variable "api_target_group_arn_suffix" {
  description = "The API target group's arn_suffix (module.alb output), or null to skip the API unhealthy-host alarm."
  type        = string
  default     = null
}

variable "ecs_cluster_arn" {
  description = "The ECS cluster ARN, or null to skip the ECS deployment-failure EventBridge rule."
  type        = string
  default     = null
}
