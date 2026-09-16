# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

output "log_group_names" {
  value = { for name, lg in aws_cloudwatch_log_group.this : name => lg.name }
}

output "alerts_topic_arn" {
  description = "The shared SNS topic every alarm/event source in this module publishes to. A human subscribes a real endpoint out-of-band unless var.alarm_topic_subscription_emails was set."
  value       = aws_sns_topic.alerts.arn
}
