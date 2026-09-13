# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# CloudWatch log groups only — see docs/aws-production-architecture.md
# §13 for the full internal-signal-to-AWS-destination mapping. No
# alarm/SNS-topic resource is created by this module: this phase's
# brief is explicit that no paid alerting service is configured yet
# (docs/aws-production-architecture.md §14 lists the required
# alert conditions/severities as a specification, not a deployed
# alarm). A follow-up phase, once a human authorizes real alerting,
# would add `aws_cloudwatch_metric_alarm`/`aws_cloudwatch_log_metric_filter`
# resources here against the log groups this module already creates.

resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(var.service_names)

  name              = "/ecs/verdictvaut-${var.environment}-${each.value}"
  retention_in_days = var.log_retention_days

  tags = {
    Environment = var.environment
    Service     = each.value
  }
}
