# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# CloudWatch log groups, plus (Phase 28) the alarm layer
# docs/aws-production-architecture.md §13/§14 specified as a
# not-yet-built follow-up since Phase 25. This phase is that follow-up:
# a human still has not authorized a PAID third-party alerting vendor
# (Datadog/PagerDuty/etc.) — nothing here adds one — but CloudWatch
# Alarms/Events/SNS are native, already-in-core-AWS-pricing building
# blocks, and this phase's own brief explicitly asks for exactly this
# coverage ("API health, worker health, ECS deployment failures,
# database connectivity, application errors, blockchain watcher/
# reconciliation failures, withdrawal/custody failures, critical
# security events... do not create noisy or useless alarms").
#
# Every alarm/event source below is wired to one shared SNS topic
# (aws_sns_topic.alerts) so a single real subscription (email, or a
# future PagerDuty/Slack SNS integration — not designed here) covers
# everything at once. No subscription is created unless a caller
# explicitly passes var.alarm_topic_subscription_emails — see that
# variable's own comment.

resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(var.service_names)

  name              = "/ecs/verdictvaut-${var.environment}-${each.value}"
  retention_in_days = var.log_retention_days

  tags = {
    Environment = var.environment
    Service     = each.value
  }
}

resource "aws_sns_topic" "alerts" {
  name = "verdictvaut-${var.environment}-alerts"

  tags = {
    Environment = var.environment
  }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  for_each = toset(var.alarm_topic_subscription_emails)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- Log-based metric filters ---------------------------------------------
# Applied to both the api and worker log groups: several of these
# signals can legitimately originate from either process depending on
# deployment configuration (e.g. ALLOW_WATCHERS_IN_API_PROCESS), not
# just the process each is documented as running in by default, and a
# metric filter costs nothing extra to attach redundantly. Every
# pattern targets the real `{"message": {"metric": "...", "tags": {...}}}`
# shape LoggingMetricsService.increment()/JsonLoggerService actually
# produce (re-read this phase, not assumed from an older description).

locals {
  metric_filter_log_groups = ["api", "worker"]

  log_metric_filters = {
    application_error = {
      pattern     = "{ $.level = \"error\" }"
      description = "Elevated ERROR-level structured log rate (api/worker) - see docs/aws-production-architecture.md §14 'Elevated API 5xx' row's log-based fallback."
      severity    = "HIGH"
      threshold   = 20
      period      = 300
    }
    reconciliation_discrepancy_critical = {
      pattern     = "{ ($.message.metric = \"wallet.reconciliation.discrepancy_found\" || $.message.metric = \"settlement.collateral_reconciliation.discrepancy_found\") && $.message.tags.severity = \"CRITICAL\" }"
      description = "A CRITICAL-severity reconciliation discrepancy (independent-reconciliation.service.ts / collateral-reconciliation.service.ts) - never auto-mutates balances, but always requires human review."
      severity    = "CRITICAL"
      threshold   = 1
      period      = 300
    }
    deposit_watcher_scan_failed = {
      pattern     = "{ $.message.metric = \"wallet.deposit_watcher.scan_failed\" }"
      description = "deposit-watcher.service.ts could not complete a scan pass for an asset/network."
      severity    = "HIGH"
      threshold   = 1
      period      = 300
    }
    withdrawal_watcher_failure = {
      pattern     = "{ ($.message.metric = \"wallet.withdrawal_watcher.marked_failed\" || $.message.metric = \"wallet.withdrawal_watcher.poll_failed\") }"
      description = "withdrawal-watcher.service.ts marked a withdrawal FAILED (on-chain failure or provider rejection) or the poll loop itself failed."
      severity    = "HIGH"
      threshold   = 1
      period      = 300
    }
    custody_compliance_provider_failure = {
      pattern     = "{ ($.message.metric = \"provider_request_failures_total\" || $.message.metric = \"provider_ambiguous_operations_total\") }"
      description = "A custody (Fireblocks) or compliance (Elliptic) provider request failed, or a custody operation's outcome is AMBIGUOUS (unknown success/failure - fireblocks-custody.adapter.ts) and requires manual reconciliation before it can be retried."
      severity    = "CRITICAL"
      threshold   = 1
      period      = 300
    }
    account_lockout = {
      pattern     = "{ $.message.metric = \"auth.account_locked\" }"
      description = "A user account was locked after repeated failed logins (auth.service.ts) - a spike is a credential-stuffing/brute-force signal. See docs/aws-production-architecture.md §14 'Authentication abuse' row, previously undetectable (no metric existed) - Phase 28 added the metric this alarm reads."
      severity    = "MEDIUM"
      threshold   = 5
      period      = 900
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "this" {
  for_each = {
    for pair in setproduct(keys(local.log_metric_filters), local.metric_filter_log_groups) :
    "${pair[0]}__${pair[1]}" => { filter_key = pair[0], service = pair[1] }
  }

  name           = "verdictvaut-${var.environment}-${each.value.filter_key}-${each.value.service}"
  log_group_name = aws_cloudwatch_log_group.this[each.value.service].name
  pattern        = local.log_metric_filters[each.value.filter_key].pattern

  metric_transformation {
    name          = "verdictvaut-${var.environment}-${each.value.filter_key}"
    namespace     = "VerdictVaut/${var.environment}"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# One alarm per filter type - the api and worker filters above both
# publish into the SAME metric name/namespace (deliberately, so one
# alarm covers the signal regardless of which process actually emitted
# it), so exactly one aws_cloudwatch_metric_alarm per key is correct,
# not one per log group.
resource "aws_cloudwatch_metric_alarm" "log_based" {
  for_each = local.log_metric_filters

  alarm_name          = "verdictvaut-${var.environment}-${each.key}"
  alarm_description   = "${each.value.severity} - ${each.value.description}"
  namespace           = "VerdictVaut/${var.environment}"
  metric_name         = "verdictvaut-${var.environment}-${each.key}"
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = {
    Environment = var.environment
    Severity    = each.value.severity
  }
}

# --- Database connectivity/availability (native RDS events, not a
# log-based signal) -----------------------------------------------------
# Same-account RDS event subscriptions do not require an explicit SNS
# topic access policy (unlike the EventBridge rule below, which does) -
# this is standard, documented same-account AWS-service-to-SNS
# behavior, not assumed. "failure"/"recovery" cover the primary
# instance being unreachable or coming back; "low storage" and
# "maintenance" are the other genuinely actionable RDS categories -
# deliberately NOT "configuration change" or "read replica" (this
# database has neither read replicas nor frequent config changes worth
# paging on).
resource "aws_db_event_subscription" "this" {
  count = var.rds_db_instance_id == null ? 0 : 1

  name      = "verdictvaut-${var.environment}-rds-events"
  sns_topic = aws_sns_topic.alerts.arn

  source_type = "db-instance"
  source_ids  = [var.rds_db_instance_id]

  event_categories = ["failure", "low storage", "maintenance", "recovery"]

  tags = {
    Environment = var.environment
  }
}

# --- API/web health (ALB target-group signals) ---------------------------

resource "aws_cloudwatch_metric_alarm" "api_unhealthy_hosts" {
  count = var.alb_arn_suffix == null || var.api_target_group_arn_suffix == null ? 0 : 1

  alarm_name          = "verdictvaut-${var.environment}-api-unhealthy-hosts"
  alarm_description   = "CRITICAL - the verdictvaut-api ALB target group has at least one unhealthy target for 3 consecutive minutes. See docs/aws-production-architecture.md §14 (API health)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.api_target_group_arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Environment = var.environment, Severity = "CRITICAL" }
}

resource "aws_cloudwatch_metric_alarm" "web_unhealthy_hosts" {
  count = var.alb_arn_suffix == null || var.web_target_group_arn_suffix == null ? 0 : 1

  alarm_name          = "verdictvaut-${var.environment}-web-unhealthy-hosts"
  alarm_description   = "HIGH - the verdictvaut-web ALB target group has at least one unhealthy target for 3 consecutive minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.web_target_group_arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Environment = var.environment, Severity = "HIGH" }
}

resource "aws_cloudwatch_metric_alarm" "elevated_5xx" {
  count = var.alb_arn_suffix == null ? 0 : 1

  alarm_name          = "verdictvaut-${var.environment}-elevated-5xx"
  alarm_description   = "HIGH - the ALB recorded 20+ HTTP 5xx responses from targets in a 5-minute window. See docs/aws-production-architecture.md §14 'Elevated API 5xx'."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 20
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Environment = var.environment, Severity = "HIGH" }
}

# --- ECS deployment failures (EventBridge, not a polled alarm) -----------
# Event shape verified live against AWS's own current docs this phase
# (docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_service_events.html):
# detail-type is "ECS Service Action" (not "ECS Deployment State
# Change", which does not exist), detail.eventName is one of a fixed
# set of INFO/WARN/ERROR event names. The three selected below are
# exactly the ERROR-type events that mean "a deployment or task could
# not become healthy" - this is the concrete mechanism behind this
# phase's "failed deployments do not silently become healthy"
# requirement, paired with modules/ecs-service's new
# deployment_circuit_breaker (which performs the actual rollback; this
# rule only makes that rollback visible to a human).
resource "aws_cloudwatch_event_rule" "ecs_deployment_failed" {
  count = var.ecs_cluster_arn == null ? 0 : 1

  name        = "verdictvaut-${var.environment}-ecs-deployment-failed"
  description = "CRITICAL - an ECS service deployment failed, could not place a task, or hit a configuration error (see modules/observability/main.tf header note for the verified event schema)."

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Service Action"]
    detail = {
      clusterArn = [var.ecs_cluster_arn]
      eventName = [
        "SERVICE_DEPLOYMENT_FAILED",
        "SERVICE_TASK_PLACEMENT_FAILURE",
        "SERVICE_TASK_CONFIGURATION_FAILURE",
      ]
    }
  })

  tags = { Environment = var.environment }
}

resource "aws_cloudwatch_event_target" "ecs_deployment_failed_sns" {
  count = var.ecs_cluster_arn == null ? 0 : 1

  rule = aws_cloudwatch_event_rule.ecs_deployment_failed[0].name
  arn  = aws_sns_topic.alerts.arn
}

# EventBridge, unlike RDS event subscriptions and CloudWatch Alarms,
# does require an explicit SNS topic access policy to publish - without
# this, the rule above would match events but silently fail to deliver
# them (a real, easy-to-miss gap; verified against AWS's own EventBridge
# documentation, not assumed from the RDS/CloudWatch same-account
# exception above).
data "aws_iam_policy_document" "sns_allow_eventbridge" {
  count = var.ecs_cluster_arn == null ? 0 : 1

  statement {
    sid    = "AllowEventBridgePublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.ecs_deployment_failed[0].arn]
    }
  }
}

resource "aws_sns_topic_policy" "allow_eventbridge" {
  count = var.ecs_cluster_arn == null ? 0 : 1

  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.sns_allow_eventbridge[0].json
}
