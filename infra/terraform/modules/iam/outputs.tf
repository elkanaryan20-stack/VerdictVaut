# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "execution_role_arn" {
  value = aws_iam_role.ecs_execution.arn
}

output "task_role_arns" {
  description = "Map of short service name -> task role ARN, e.g. { web = \"...\", api = \"...\", worker = \"...\" }."
  value       = { for name, role in aws_iam_role.task : name => role.arn }
}
