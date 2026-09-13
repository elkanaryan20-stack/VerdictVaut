# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Creates Secrets Manager secret OBJECTS only — no secret VALUE is set
# by this module, or by any Terraform code in this repository. A human
# (or a separate, more tightly-scoped process) sets each secret's real
# value out-of-band via the AWS Console or CLI after `apply`, exactly
# as docs/aws-iam-and-secrets.md §7 requires. This is deliberate, not
# an oversight — a secret value in a .tf/.tfvars file (even one marked
# `sensitive`) still passes through Terraform's plan/state machinery,
# which this design avoids entirely for every credential.

locals {
  name_prefix = "verdictvaut/${var.environment}"
}

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(var.secret_names)

  name                    = "${local.name_prefix}/${each.value}"
  description             = "VerdictVaut ${var.environment} — ${each.value}. Value set out-of-band, never via Terraform. See docs/aws-iam-and-secrets.md §3."
  recovery_window_in_days = var.recovery_window_days

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform-object-only-no-value"
  }
}
