# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "endpoint" {
  description = "RDS connection endpoint (host:port)."
  value       = aws_db_instance.this.endpoint
}

output "database_url_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the fully-composed DATABASE_URL string — see modules/database/main.tf's credential design note for why this exists instead of using RDS's native manage_master_user_password JSON secret."
  value       = aws_secretsmanager_secret.database_url.arn
}

output "db_instance_identifier" {
  value = aws_db_instance.this.identifier
}
