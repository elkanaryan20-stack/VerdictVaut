# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Implements docs/aws-disaster-recovery.md §1: PostgreSQL 16, isolated
# subnet group, force_ssl parameter group, automated backups + PITR,
# encryption at rest, and environment-driven Multi-AZ / deletion-
# protection settings.
#
# CREDENTIAL DESIGN NOTE (a real finding from this phase, not glossed
# over): RDS's native `manage_master_user_password` feature stores the
# credential as a JSON object ({username, password, ...}) in Secrets
# Manager, not as a single connection-string value. This codebase's
# existing `env.validation.ts`/`ConfigService` reads one plain
# `DATABASE_URL` string (e.g. "postgresql://user:pass@host:5432/db?sslmode=require")
# — using the native feature as-is would require adding an entrypoint/
# wrapper script to assemble DATABASE_URL from the JSON secret's
# individual fields at container start, which is an APPLICATION change
# this infra-only phase does not make. Instead, this module generates
# the master password itself (`random_password`, provider-marked
# sensitive) and stores the fully-composed DATABASE_URL string directly
# in Secrets Manager — a very standard Terraform/AWS pattern, and the
# one narrow, deliberate exception to this repository's "Terraform
# never sets a secret value" principle (infra/terraform/README.md /
# docs/aws-iam-and-secrets.md §7) — justified specifically because it
# avoids an application code change in a phase scoped to infrastructure
# only. The password does live in Terraform state as a result — the S3
# backend's `encrypt = true` (environments/*/backend.tf) and the
# bucket's own access controls (documented, not created, in
# infra/terraform/README.md) are the real protection for that, same as
# for any Terraform-managed database credential.

locals {
  name_prefix = "verdictvaut-${var.environment}"
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.name_prefix}-db-subnet-group"
  subnet_ids = var.db_subnet_ids

  tags = {
    Name        = "${local.name_prefix}-db-subnet-group"
    Environment = var.environment
  }
}

# force_ssl=1 is the AWS-side enforcement layer, independent of and
# redundant with the application's own fail-closed
# database-tls.validator.ts check (apps/api/src/config/database-tls.validator.ts,
# unchanged by this phase) — intentional defense-in-depth, not a
# duplicate to be simplified away.
resource "aws_db_parameter_group" "this" {
  name        = "${local.name_prefix}-postgres16-params"
  family      = "postgres16"
  description = "VerdictVaut ${var.environment} — forces TLS at the database layer (see docs/aws-disaster-recovery.md §1)."

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = {
    Name        = "${local.name_prefix}-postgres16-params"
    Environment = var.environment
  }
}

resource "random_password" "master" {
  length  = 32
  special = false # avoid characters that need URL-encoding inside a postgresql:// connection string
}

resource "aws_db_instance" "this" {
  identifier     = "${local.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = "16"
  db_name        = var.db_name

  instance_class        = var.instance_class
  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.vpc_security_group_id]
  parameter_group_name   = aws_db_parameter_group.this.name

  # Non-negotiable — docs/aws-network-design.md §2's "RDS must NOT be
  # publicly accessible" requirement, enforced at the resource level
  # (in addition to, not instead of, the DB subnet tier's own lack of
  # an internet route in module.network).
  publicly_accessible = false

  multi_az            = var.multi_az
  deletion_protection = var.deletion_protection

  backup_retention_period = var.backup_retention_days
  backup_window            = var.backup_window
  maintenance_window       = var.maintenance_window

  username = "verdictvaut"
  password = random_password.master.result

  performance_insights_enabled = var.enable_performance_insights

  # NOTE on Terraform's own `prevent_destroy` lifecycle meta-argument:
  # it cannot be set from a variable (a hard HCL constraint — lifecycle
  # arguments must be static literals), so it cannot safely differ
  # between staging and production within this single shared module
  # without either duplicating this resource or hardcoding a value that
  # would then also block staging teardown. It is deliberately NOT set
  # here for that reason — `var.deletion_protection` (the AWS-level
  # control, which IS a genuine per-environment variable, above) is the
  # real, per-environment safety mechanism this design relies on. If a
  # Terraform-level `prevent_destroy = true` is wanted for production
  # specifically, the production environment root module
  # (environments/production/main.tf) should declare that resource
  # directly rather than through this shared module — not done in this
  # phase, since it would duplicate this entire resource block for one
  # extra guard AWS's own deletion_protection already provides.
  tags = {
    Name        = "${local.name_prefix}-postgres"
    Environment = var.environment
  }
}

# The fully-composed connection string — this is what the ECS task
# definitions actually inject as DATABASE_URL (docs/aws-iam-and-secrets.md
# §3/§4). sslmode=require matches database-tls.validator.ts's own
# fail-closed expectation for APP_ENVIRONMENT=production.
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "verdictvaut/${var.environment}/database-url"
  description             = "VerdictVaut ${var.environment} — composed DATABASE_URL connection string. See modules/database/main.tf's credential design note."
  recovery_window_in_days = 30

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://verdictvaut:${random_password.master.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.db_name}?sslmode=require"
}
