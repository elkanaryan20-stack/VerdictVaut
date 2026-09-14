# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "ecr_repository_arns" {
  description = "Map of short repository name -> ARN. Consumed by environments/{staging,production}/main.tf via a terraform_remote_state data source, once a real backend exists (see infra/terraform/README.md)."
  value       = module.ecr.repository_arns
}

output "ecr_repository_urls" {
  description = "Map of short repository name -> repository URL — the prefix for a real image reference (e.g. \"<url>:<commit-sha>\") once CI is authorized to push."
  value       = module.ecr.repository_urls
}
