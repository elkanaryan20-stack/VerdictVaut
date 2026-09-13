# DESIGNED, NOT APPLIED. See infra/terraform/README.md.

locals {
  name_prefix = "verdictvaut-${var.environment}"
}

resource "aws_lb" "this" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]

  # ALB access logs (docs/aws-production-architecture.md §9's "optional
  # but recommended" S3 destination) are deliberately NOT enabled here —
  # would require an S3 bucket + bucket policy this skeleton does not
  # create, consistent with that section's "OPTIONAL" labeling.

  tags = {
    Name        = "${local.name_prefix}-alb"
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # required for awsvpc-mode Fargate tasks

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    Name        = "${local.name_prefix}-web-tg"
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api-tg"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    Name        = "${local.name_prefix}-api-tg"
    Environment = var.environment
  }
}

# --- ACM certificate (optional path — see variables.tf) -------------------

resource "aws_acm_certificate" "this" {
  count             = var.create_certificate ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${local.name_prefix}-cert"
    Environment = var.environment
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.create_certificate ? {
    for dvo in aws_acm_certificate.this[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "this" {
  count                   = var.create_certificate ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

locals {
  # The certificate actually attached to the HTTPS listener — either
  # the one this module just created + validated, or the pre-existing
  # ARN passed in directly. Exactly one of the two input paths is
  # expected to be populated; both are null in this skeleton, since no
  # domain/certificate exists yet.
  effective_certificate_arn = var.create_certificate ? aws_acm_certificate_validation.this[0].certificate_arn : var.certificate_arn
}

# --- Listeners --------------------------------------------------------

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.effective_certificate_arn

  # Default action: web. The API rule below takes precedence for
  # matching requests (docs/aws-deployment-runbook.md §2).
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener_rule" "api_by_host" {
  count        = var.api_host_header == null ? 0 : 1
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [var.api_host_header]
    }
  }
}

resource "aws_lb_listener_rule" "api_by_path" {
  count        = var.api_host_header == null ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = var.api_path_patterns
    }
  }
}
