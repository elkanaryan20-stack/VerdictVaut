# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "web_target_group_arn" {
  value = aws_lb_target_group.web.arn
}

output "api_target_group_arn" {
  value = aws_lb_target_group.api.arn
}

# Phase 28 — CloudWatch's AWS/ApplicationELB metrics are dimensioned by
# arn_suffix (e.g. "app/verdictvaut-production-alb/1234567890abcdef"),
# not the full ARN — consumed by module.observability's ALB alarms.
output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "web_target_group_arn_suffix" {
  value = aws_lb_target_group.web.arn_suffix
}

output "api_target_group_arn_suffix" {
  value = aws_lb_target_group.api.arn_suffix
}
