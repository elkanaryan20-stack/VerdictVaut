# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  value = aws_subnet.app[*].id
}

output "db_subnet_ids" {
  value = aws_subnet.db[*].id
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "web_task_security_group_id" {
  value = aws_security_group.web_task.id
}

output "api_task_security_group_id" {
  value = aws_security_group.api_task.id
}

output "worker_task_security_group_id" {
  value = aws_security_group.worker_task.id
}

output "rds_security_group_id" {
  value = aws_security_group.rds.id
}
