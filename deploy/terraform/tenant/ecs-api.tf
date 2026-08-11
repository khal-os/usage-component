# Shared container-definition fragments. Atlas is the factory's database
# mode (decision 140) — MONGO_DB_ATLAS is a constant, and host/credentials
# come from the tenant secret (never tfvars, never state-visible env).
locals {
  module_image = "${local.fdn.ecr_repository_urls["platform-module"]}:${var.image_sha}"
  conn_image   = "${local.fdn.ecr_repository_urls["platform-connector"]}:${var.image_sha}"
  backup_image = "${local.fdn.ecr_repository_urls["platform-backup"]}:${var.image_sha}"

  mongo_env = [
    { name = "MONGO_DB_ATLAS", value = "true" },
    { name = "MONGO_USAGE_DB_NAME", value = var.mongo_usage_db_name },
  ]

  mongo_secrets = [
    for k in ["MONGO_DB_HOST", "MONGO_DB_USER", "MONGO_DB_PASSWORD"] :
    { name = k, valueFrom = "${aws_secretsmanager_secret.tenant.arn}:${k}::" }
  ]

  base_env = concat(local.mongo_env, [
    { name = "ENVIRONMENT", value = "production" },
    { name = "CLIENT_NAME", value = var.client_name },
    { name = "CLIENT_TIMEZONE", value = var.client_timezone },
  ])

  log_conf = {
    for k, g in aws_cloudwatch_log_group.services :
    k => {
      logDriver = "awslogs"
      options = {
        awslogs-group         = g.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }
}

# ── Security groups ──────────────────────────────────────────────────────────

# The api receives from the ALB only; workers receive nothing.
resource "aws_security_group" "api" {
  name_prefix = "${local.name}-api-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "workers" {
  name_prefix = "${local.name}-workers-"
  description = "connector/scheduler/backup — egress only"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ── Module API ───────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name         = "api"
    image        = local.module_image
    essential    = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = concat(local.base_env, [
      { name = "SERVER_PORT", value = "3000" },
      { name = "CORS_ALLOWED_ORIGINS", value = var.cors_allowed_origins },
    ])
    # Decision 141: the interim gate's pair rides the tenant secret; off
    # only when the KHAL quartet takes over.
    secrets = concat(local.mongo_secrets, var.enable_basic_auth ? [
      for k in ["BASIC_AUTH_USER", "BASIC_AUTH_PASSWORD"] :
      { name = k, valueFrom = "${aws_secretsmanager_secret.tenant.arn}:${k}::" }
    ] : [])
    logConfiguration = local.log_conf["api"]
  }])
}

resource "aws_lb_target_group" "api" {
  name        = substr("${local.name}-api", 0, 32)
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    # Decision 103: /api/v1/docs stays open even with auth on — it IS the
    # healthcheck surface.
    path    = "/api/v1/docs"
    matcher = "200-399"
  }

  deregistration_delay = 30
}

# Decision 142: the listener is THIS tenant's own — priorities are plain.
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [local.api_hostname]
    }
  }
}

resource "aws_route53_record" "api" {
  zone_id = local.fdn.route53_zone_id
  name    = local.api_hostname
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = local.fdn.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Zero-downtime rolling swap; circuit breaker rolls back a deploy whose
  # tasks never pass the ALB health check.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.api.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  lifecycle {
    # The deploy script rolls task-definition revisions; terraform must not
    # fight it back to an older SHA on the next apply.
    ignore_changes = [task_definition]
  }
}

# Auto-scaling from day one (decision 140): min 1, scale on CPU.
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${local.fdn.ecs_cluster_name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 1
  max_capacity       = var.api_autoscale_max
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
