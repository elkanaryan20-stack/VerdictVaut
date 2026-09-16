# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "ci_deploy_role_arn" {
  description = "Assumed by GitHub Actions via OIDC (aws-actions/configure-aws-credentials, role-to-assume) - no long-lived AWS access key is ever used. See .github/workflows/terraform-deploy.yml and ecr-publish.yml."
  value       = aws_iam_role.ci_deploy.arn
}

output "github_oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github.arn
}
