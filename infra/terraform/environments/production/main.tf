# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Production. Differences from environments/staging/main.tf, all
# deliberate:
#   - nat_gateway_per_az = true (docs/aws-network-design.md §4)
#   - multi_az = true, deletion_protection = true (docs/aws-disaster-recovery.md §1)
#   - APP_ENVIRONMENT = "production" everywhere
#   - The secret list does NOT include any Fireblocks/Elliptic entry —
#     production custody/compliance integrations do not exist in this
#     codebase (ProductionCustodyExecutor unconditionally throws,
#     ComplianceGateFactory unconditionally forces DeferredComplianceGate
#     — docs/aws-production-architecture.md §11, unchanged). Creating a
#     "verdictvaut/production/fireblocks-credentials"-shaped secret
#     object here, with no real integration behind it, would misleadingly
#     imply production custody is nearly ready — it is not, and this
#     file does not pretend otherwise.

locals {
  environment   = "production"
  service_names = ["web", "api", "worker"]
  secret_names  = ["jwt-access-secret", "jwt-refresh-secret", "postmark-server-token"]
}

module "network" {
  source = "../../modules/network"

  environment         = local.environment
  vpc_cidr            = var.vpc_cidr
  availability_zones  = var.availability_zones
  public_subnet_cidrs = var.public_subnet_cidrs
  app_subnet_cidrs    = var.app_subnet_cidrs
  db_subnet_cidrs     = var.db_subnet_cidrs
  nat_gateway_per_az  = true # production — one NAT per AZ, docs/aws-network-design.md §4
}

module "observability" {
  source = "../../modules/observability"

  environment   = local.environment
  service_names = local.service_names
}

module "secrets" {
  source = "../../modules/secrets"

  environment  = local.environment
  secret_names = local.secret_names
}

module "database" {
  source = "../../modules/database"

  environment            = local.environment
  db_subnet_ids          = module.network.db_subnet_ids
  vpc_security_group_id  = module.network.rds_security_group_id
  instance_class          = var.db_instance_class
  multi_az               = true # production — docs/aws-disaster-recovery.md §1
  deletion_protection    = true # production — non-negotiable, same doc
}

module "iam" {
  source = "../../modules/iam"

  environment         = local.environment
  task_role_names     = local.service_names
  ecr_repository_arns = [] # no ECR repository exists yet — docs/aws-deployment-runbook.md §3
  log_group_arns      = [for name, arn in module.observability.log_group_names : "${arn}:*"]
  secret_arns = concat(
    values(module.secrets.secret_arns),
    [module.database.database_url_secret_arn],
  )
}

module "alb" {
  source = "../../modules/alb"

  environment           = local.environment
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  alb_security_group_id = module.network.alb_security_group_id
  create_certificate    = false
  certificate_arn       = var.certificate_arn # no real value supplied by this phase
}

resource "aws_ecs_cluster" "this" {
  name = "verdictvaut-${local.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Environment = local.environment
  }
}

module "web_service" {
  source = "../../modules/ecs-service"

  name               = "verdictvaut-${local.environment}-web"
  environment        = local.environment
  cluster_id         = aws_ecs_cluster.this.id
  image              = var.web_image
  container_port     = 3000
  cpu                = 256
  memory             = 512
  desired_count      = 2
  subnet_ids         = module.network.app_subnet_ids
  security_group_ids = [module.network.web_task_security_group_id]
  target_group_arn   = module.alb.web_target_group_arn
  execution_role_arn = module.iam.execution_role_arn
  task_role_arn      = module.iam.task_role_arns["web"]
  log_group_name     = module.observability.log_group_names["web"]
  aws_region         = var.aws_region

  # Full-availability rolling deploy — never a capacity gap for a
  # public-facing service (docs/aws-deployment-runbook.md §1).
  min_healthy_percent = 100
  max_percent          = 200

  environment_variables = {
    NEXT_PUBLIC_APP_ENVIRONMENT = "production"
  }
}

module "api_service" {
  source = "../../modules/ecs-service"

  name               = "verdictvaut-${local.environment}-api"
  environment        = local.environment
  cluster_id         = aws_ecs_cluster.this.id
  image              = var.api_image
  container_port     = 4000
  cpu                = 512
  memory             = 1024
  desired_count      = 2
  subnet_ids         = module.network.app_subnet_ids
  security_group_ids = [module.network.api_task_security_group_id]
  target_group_arn   = module.alb.api_target_group_arn
  execution_role_arn = module.iam.execution_role_arn
  task_role_arn      = module.iam.task_role_arns["api"]
  log_group_name     = module.observability.log_group_names["api"]
  aws_region         = var.aws_region

  min_healthy_percent = 100
  max_percent          = 200

  environment_variables = {
    PORT                       = "4000"
    APP_ENVIRONMENT            = "production"
    CORS_ALLOWED_ORIGINS       = var.cors_allowed_origins
    CHAIN_WATCHER_ENABLED      = "false" # the worker service runs watchers — watcher-boundary.guard.ts enforces this at the code level too
    WITHDRAWAL_WATCHER_ENABLED = "false"
    EMAIL_PROVIDER             = "postmark"
    EMAIL_FROM_ADDRESS         = var.email_from_address
    EMAIL_BASE_URL             = var.email_base_url
  }

  # NOTE: env.validation.ts unconditionally refuses to boot with
  # APP_ENVIRONMENT=production today regardless of any of the above
  # (docs/aws-production-architecture.md §11/§12) — this is the
  # intended, fail-closed behavior; this task definition is designed to
  # be correct for when that changes, not a claim that production can
  # boot today.
  secret_arns = {
    DATABASE_URL           = module.database.database_url_secret_arn
    JWT_ACCESS_SECRET      = module.secrets.secret_arns["jwt-access-secret"]
    JWT_REFRESH_SECRET     = module.secrets.secret_arns["jwt-refresh-secret"]
    POSTMARK_SERVER_TOKEN  = module.secrets.secret_arns["postmark-server-token"]
  }
}

module "worker_service" {
  source = "../../modules/ecs-service"

  name               = "verdictvaut-${local.environment}-worker"
  environment        = local.environment
  cluster_id         = aws_ecs_cluster.this.id
  image              = var.worker_image
  container_port     = null # no HTTP surface — worker.main.ts's own design
  cpu                = 256
  memory             = 512
  desired_count      = 1 # docs/aws-deployment-runbook.md §1
  subnet_ids         = module.network.app_subnet_ids
  security_group_ids = [module.network.worker_task_security_group_id]
  target_group_arn   = null # NEVER attached to the ALB
  execution_role_arn = module.iam.execution_role_arn
  task_role_arn      = module.iam.task_role_arns["worker"]
  log_group_name     = module.observability.log_group_names["worker"]
  aws_region         = var.aws_region

  min_healthy_percent = 0 # safe at desired_count 1 — docs/production-deployment-plan.md §6
  max_percent          = 200

  health_check_command = ["CMD", "node", "scripts/worker-healthcheck.js"]

  environment_variables = {
    APP_ENVIRONMENT              = "production"
    CHAIN_WATCHER_ENABLED        = "true"
    WITHDRAWAL_WATCHER_ENABLED   = "true"
    WORKER_HEARTBEAT_FILE        = "/tmp/verdictvaut-worker-heartbeat"
    WORKER_HEARTBEAT_INTERVAL_MS = "15000"
  }

  # No Fireblocks/Elliptic secret is wired here — production custody is
  # structurally blocked at the application level regardless
  # (ProductionCustodyExecutor throws unconditionally); wiring a
  # nonexistent production credential here would be pure fiction.
  secret_arns = {
    DATABASE_URL = module.database.database_url_secret_arn
  }
}
