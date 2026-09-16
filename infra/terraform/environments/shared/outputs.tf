# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "ecr_repository_arns" {
  description = "Map of short repository name -> ARN. Consumed by environments/{staging,production}/main.tf via a terraform_remote_state data source, once a real backend exists (see infra/terraform/README.md)."
  value       = module.ecr.repository_arns
}

output "ecr_repository_urls" {
  description = "Map of short repository name -> repository URL — the prefix for a real image reference (e.g. \"<url>:<commit-sha>\") once CI is authorized to push."
  value       = module.ecr.repository_urls
}

output "ci_deploy_role_arn" {
  description = "Phase 28. Set as the AWS_CI_DEPLOY_ROLE_ARN GitHub secret once this is actually provisioned — see .github/workflows/ecr-publish.yml."
  value       = module.ci_deploy_role.ci_deploy_role_arn
}
