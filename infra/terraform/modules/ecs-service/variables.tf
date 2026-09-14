# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# One reusable module, instantiated 3x per environment (web, api,
# worker — see environments/*/main.tf) with different inputs. The
# worker instantiation passes container_port = null and
# target_group_arn = null, which is what keeps it off the ALB entirely
# (docs/aws-deployment-runbook.md §1 — "no target group at all").

variable "name" {
  description = "Service name, e.g. \"verdictvaut-api\"."
  type        = string
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be exactly \"staging\" or \"production\"."
  }
}

variable "cluster_id" {
  description = "ECS cluster ID/ARN this service runs in."
  type        = string
}

variable "image" {
  description = "Full ECR image URI including tag, e.g. \"<account-id>.dkr.ecr.<region>.amazonaws.com/verdictvaut-api:<commit-sha>\" — never \"latest\" for a real deployment (docs/aws-deployment-runbook.md §3). No real value is set by this phase."
  type        = string
}

variable "container_port" {
  description = "HTTP port the container listens on, or null for a service with no HTTP surface (the worker — docs/aws-deployment-runbook.md §1)."
  type        = number
  default     = null
}

variable "cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU, 512 = 0.5 vCPU, ...). No verified-by-load-test default exists (docs/aws-disaster-recovery.md §1's own caveat applies equally here) — must be set explicitly per environment/service."
  type        = number
}

variable "memory" {
  description = "Fargate task memory, MB. Must be a value Fargate accepts for the chosen `cpu` (AWS's own fixed CPU/memory combinations)."
  type        = number
}

variable "desired_count" {
  type = number
}

variable "environment_variables" {
  description = "Plain (non-secret) environment variables, e.g. { PORT = \"4000\", APP_ENVIRONMENT = \"sandbox\" }. See docs/aws-deployment-runbook.md §1 for the per-service list."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Map of container env-var name -> Secrets Manager secret ARN, injected via the ECS task definition's `secrets` field (never baked into the image) — see docs/aws-iam-and-secrets.md §4."
  type        = map(string)
  default     = {}
}

variable "execution_role_arn" {
  description = "The shared verdictvaut-ecs-execution-role ARN (docs/aws-iam-and-secrets.md §2.1)."
  type        = string
}

variable "task_role_arn" {
  description = "This service's own task role ARN (docs/aws-iam-and-secrets.md §2.2/§2.3/§2.4 — may legitimately be a role with zero extra permissions)."
  type        = string
}

variable "subnet_ids" {
  description = "Private application subnet IDs (module.network.app_subnet_ids) — never a public subnet."
  type        = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "target_group_arn" {
  description = "ALB target group ARN, or null for a service with no ALB attachment at all (the worker — docs/aws-deployment-runbook.md §1/§2)."
  type        = string
  default     = null
}

variable "log_group_name" {
  type = string
}

variable "aws_region" {
  description = "Region for the awslogs log driver configuration. No default — set per environment, never invented (docs/aws-production-architecture.md §10 — region selection requires human approval)."
  type        = string
}

variable "health_check_command" {
  description = "Container-level HEALTHCHECK command override, e.g. [\"CMD\", \"node\", \"scripts/worker-healthcheck.js\"] for the worker. null uses the image's own baked-in Dockerfile HEALTHCHECK (web/API)."
  type        = list(string)
  default     = null
}

variable "min_healthy_percent" {
  type    = number
  default = 100
}

variable "max_percent" {
  type    = number
  default = 200
}

variable "read_only_root_filesystem" {
  description = "Phase 27 addition. Defaults to false — NOT independently verified against a real running container this session (no Docker available; see infra/terraform/README.md's own long-standing Docker-availability caveat), so it is not force-enabled for web/api/worker here. web (Next.js standalone) and api/worker (NestJS) are not known to require any other writable path than /tmp (already handled via tmpfs when this is true — see main.tf), but that has not been proven against a live container. Set true per-service only after verifying the specific image tolerates it."
  type        = bool
  default     = false
}

variable "tmpfs_size_mib" {
  description = "Size (MiB) of the /tmp tmpfs mount added when read_only_root_filesystem = true. Only meaningful in that case."
  type        = number
  default     = 64
}
