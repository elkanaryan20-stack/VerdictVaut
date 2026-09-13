# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "secret_arns" {
  description = "Map of logical secret name -> ARN, for wiring into module.ecs-service's `secrets` input and module.iam-scoped execution-role policies."
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.arn }
}
