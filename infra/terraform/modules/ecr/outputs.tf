# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "repository_arns" {
  description = "Map of short repository name -> ARN, for module.iam's ecr_repository_arns input."
  value       = { for name, repo in aws_ecr_repository.this : name => repo.arn }
}

output "repository_urls" {
  description = "Map of short repository name -> repository URL, for constructing image references (e.g. var.api_image once a real image is pushed)."
  value       = { for name, repo in aws_ecr_repository.this : name => repo.repository_url }
}
