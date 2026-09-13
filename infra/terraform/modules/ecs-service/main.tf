# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Reusable Fargate service module — see docs/aws-deployment-runbook.md
# §1. Instantiated once each for web, api, and worker by
# environments/*/main.tf. The worker instantiation (container_port =
# null, target_group_arn = null) is what structurally keeps it off the
# ALB — there is no separate "worker module," so there is no way for
# the worker's own definition to drift from the web/api services'
# shape except via the inputs the calling environment explicitly
# passes.

locals {
  # Built as a local, then merged with an optional healthCheck key, so
  # that a null health_check_command produces a container definition
  # with NO "healthCheck" key at all — rather than jsonencode emitting
  # a literal `"healthCheck": null`, which the ECS API may not accept
  # the same way as an absent key (not independently verified against
  # AWS's own API docs this session; omitting the key entirely is the
  # unambiguously safe choice either way).
  base_container_definition = {
    name      = var.name
    image     = var.image
    essential = true

    portMappings = var.container_port == null ? [] : [
      {
        containerPort = var.container_port
        protocol      = "tcp"
      }
    ]

    environment = [
      for k, v in var.environment_variables : { name = k, value = v }
    ]

    secrets = [
      for k, arn in var.secret_arns : { name = k, valueFrom = arn }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = var.log_group_name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = var.name
      }
    }
  }

  health_check_addition = var.health_check_command == null ? {} : {
    healthCheck = {
      command     = var.health_check_command
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }

  container_definition = merge(local.base_container_definition, local.health_check_addition)
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([local.container_definition])

  tags = {
    Name        = var.name
    Environment = var.environment
  }
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = var.min_healthy_percent
  deployment_maximum_percent         = var.max_percent

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false # Never — the ALB is the only public ingress path (docs/aws-network-design.md §6)
  }

  # Only present when var.target_group_arn is non-null — the worker
  # service (target_group_arn = null) gets NO load_balancer block at
  # all, matching AWS's own documented support for a Fargate service
  # with no attached load balancer (docs/production-infrastructure-decision.md's
  # Phase 24 addendum verified this against AWS's own ECS docs).
  dynamic "load_balancer" {
    for_each = var.target_group_arn == null ? [] : [var.target_group_arn]
    content {
      target_group_arn = load_balancer.value
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  lifecycle {
    ignore_changes = [
      # A future CI/CD deploy (docs/aws-deployment-runbook.md §4.2)
      # updates task_definition directly via `ecs update-service` —
      # this prevents a routine `terraform apply` for an unrelated
      # change (e.g. a security-group rule) from reverting a deploy
      # that happened outside Terraform in between.
      task_definition,
    ]
  }

  tags = {
    Name        = var.name
    Environment = var.environment
  }
}
