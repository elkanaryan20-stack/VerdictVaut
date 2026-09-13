# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

locals {
  name_prefix = "verdictvaut-${var.environment}"
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# --- ECS task execution role (docs/aws-iam-and-secrets.md §2.1) -----------
# Used by the ECS agent to pull the image and inject secrets/logs —
# never assumed by application code itself.

resource "aws_iam_role" "ecs_execution" {
  name               = "${local.name_prefix}-ecs-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json

  tags = {
    Environment = var.environment
  }
}

data "aws_iam_policy_document" "ecs_execution" {
  # Only rendered as non-empty statements when the corresponding ARN
  # list is non-empty — an empty resource list below means "this role
  # currently cannot do this at all," which is the correct, safe
  # starting state before the referenced resources (ECR repos, log
  # groups, secrets) actually exist.

  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) > 0 ? [1] : []
    content {
      sid       = "PullFromVerdictVautEcrRepos"
      actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
      resources = var.ecr_repository_arns
    }
  }

  # ecr:GetAuthorizationToken has no resource-level permissions — it
  # must be granted on "*", which AWS documents as the only valid
  # scope for this specific action (not a least-privilege compromise;
  # there is no narrower resource ARN this action accepts).
  statement {
    sid       = "EcrAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = length(var.log_group_arns) > 0 ? [1] : []
    content {
      sid       = "WriteVerdictVautLogs"
      actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      resources = var.log_group_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.secret_arns) > 0 ? [1] : []
    content {
      sid       = "ReadVerdictVautSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = var.secret_arns
    }
  }
}

resource "aws_iam_role_policy" "ecs_execution" {
  name   = "${local.name_prefix}-ecs-execution-policy"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution.json
}

# --- Per-service task roles (docs/aws-iam-and-secrets.md §2.2-§2.4) -------
# Zero attached permissions by design — re-verified repeatedly (Phases
# 23-25) that no application code in this repository calls any AWS API
# directly. A future feature that genuinely needs a direct AWS call
# should add a narrowly-scoped aws_iam_role_policy against the specific
# role below AT THAT TIME, not speculatively now.

resource "aws_iam_role" "task" {
  for_each = toset(var.task_role_names)

  name               = "${local.name_prefix}-${each.value}-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json

  tags = {
    Environment = var.environment
    Service     = each.value
  }
}
