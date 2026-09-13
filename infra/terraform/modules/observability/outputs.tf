# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "log_group_names" {
  value = { for name, lg in aws_cloudwatch_log_group.this : name => lg.name }
}
