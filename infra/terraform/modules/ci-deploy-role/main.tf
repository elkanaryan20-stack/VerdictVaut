# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Phase 28 — implements the CI/CD deploy role docs/aws-iam-and-secrets.md
# §2.5 has specified since Phase 25 ("Not created or used by this
# phase" there — this module is that follow-up, once this phase's own
# brief asked for a real deployment workflow). Account-level (one GitHub
# OIDC provider per AWS account — a second `aws_iam_openid_connect_provider`
# for the same issuer URL in the same account is rejected by AWS), so
# this is instantiated once from environments/shared, not per
# environment — same reasoning as modules/ecr.
#
# This role can reach BOTH staging and production's ECS
# services/IAM roles (constructed deterministically below, never via a
# cross-environment terraform_remote_state read — staging and
# production's own state stays fully isolated, see
# docs/aws-terraform-security-review.md's "share no state" finding).
# That is intentional: the build-once/promote pipeline
# (docs/aws-deployment-runbook.md §4.2) is ONE workflow that deploys to
# staging automatically and to production only after a human-gated
# approval step — narrowing this role to "can push images and update
# services in either environment" and relying on the GitHub Environment
# protection rule (configured outside Terraform, see
# docs/aws-production-change-control.md §1) for the human gate matches
# how that pipeline is actually designed to run. It is NOT narrowed
# to a single environment because doing so would require two separate
# deploy roles/workflows, which the existing design documents do not
# call for.

data "aws_caller_identity" "current" {}

# Thumbprint: the SHA1 fingerprint of the root CA
# (ISRG Root X1) at the top of token.actions.githubusercontent.com's
# real certificate chain, computed THIS SESSION by actually connecting
# to it (`openssl s_client -connect token.actions.githubusercontent.com:443
# -showcerts`, then `openssl x509 -noout -fingerprint -sha1` on the
# top-most certificate returned) rather than copied from a possibly
# stale memorized value — GitHub's OIDC TLS certificate is issued via
# Let's Encrypt, not the DigiCert chain older guidance sometimes cites,
# so a memorized thumbprint would likely have been wrong. Per both
# AWS's and GitHub's own current documentation (re-read this phase),
# this value is not actually used for verification against a
# publicly-trusted-CA-backed provider like this one — AWS validates
# via its own trusted CA bundle and only falls back to thumbprint
# matching if that lookup fails — but `aws_iam_openid_connect_provider`
# still requires a syntactically valid 40-character SHA1 hex string to
# be set. Re-verify this value if this module is ever actually applied
# (a certificate/CA change on GitHub's side would not break
# authentication, per the above, but would make this stored value
# stale — harmless, not a correctness requirement, only a note-to-self
# for future accuracy).
locals {
  github_oidc_thumbprint = "ab9d0263244dd0326eb67015705a667e79cfe998"

  ecs_service_arns = flatten([
    for env in var.environments : [
      for svc in var.service_names :
      "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/verdictvaut-${env}/verdictvaut-${env}-${svc}"
    ]
  ])

  execution_role_arns = [
    for env in var.environments :
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/verdictvaut-${env}-ecs-execution-role"
  ]

  task_role_arns = flatten([
    for env in var.environments : [
      for svc in var.service_names :
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/verdictvaut-${env}-${svc}-task-role"
    ]
  ])
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [local.github_oidc_thumbprint]

  tags = {
    Purpose = "github-actions-oidc"
  }
}

# Restricted to this one repository, any ref within it - deliberately
# NOT narrowed further to e.g. "ref:refs/heads/main" here, since the
# real deployment workflow's exact trigger conditions (branch vs. tag
# vs. environment-scoped GitHub deployment) are not finalized against a
# real account yet (see .github/workflows/terraform-deploy.yml's own
# header note). A human should narrow this `sub` condition to match
# the real workflow's actual trigger before this is ever applied.
data "aws_iam_policy_document" "ci_deploy_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = "verdictvaut-ci-deploy-role"
  assume_role_policy = data.aws_iam_policy_document.ci_deploy_assume_role.json

  tags = {
    Purpose = "ci-cd-deploy"
  }
}

# Exactly docs/aws-iam-and-secrets.md §2.5's 3 permission groups - no
# broader access than that document already specified is granted here.
data "aws_iam_policy_document" "ci_deploy" {
  statement {
    sid       = "PushVerdictVautImages"
    actions   = ["ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchCheckLayerAvailability"]
    resources = var.ecr_repository_arns
  }

  # Same AWS API constraint as modules/iam's own ecr:GetAuthorizationToken
  # statement - this action has no resource-level ARN to scope to.
  statement {
    sid       = "EcrAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "DeployVerdictVautEcsServices"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = local.ecs_service_arns
  }

  # Never iam:PassRole on "*" - scoped to exactly the execution role
  # plus the specific task roles a deploy could legitimately pass,
  # across both environments this one shared role can reach.
  statement {
    sid       = "PassVerdictVautEcsRolesOnly"
    actions   = ["iam:PassRole"]
    resources = concat(local.execution_role_arns, local.task_role_arns)

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "ci_deploy" {
  name   = "verdictvaut-ci-deploy-policy"
  role   = aws_iam_role.ci_deploy.id
  policy = data.aws_iam_policy_document.ci_deploy.json
}
