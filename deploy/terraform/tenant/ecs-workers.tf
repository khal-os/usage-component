# ── Connector (trace-ingestion-worker) ───────────────────────────────────────
# STRICT SINGLETON (decision 140): stop-then-start deploys — the sync
# watermark has no lease, so two live workers would double-read; the
# seconds-long gap is erased by idempotent catch-up.

resource "aws_ecs_task_definition" "connector" {
  family                   = "${local.name}-connector"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "connector"
    image     = local.conn_image
    essential = true
    # 60s grace mirrors the compose stop_grace_period: one batch finishes
    # before SIGKILL.
    stopTimeout = 60
    environment = concat(local.base_env, [
      { name = "TRACE_INGESTION_INTERVAL_SECONDS", value = tostring(var.trace_ingestion_interval_seconds) },
      { name = "TRACE_INGESTION_BATCH_SIZE", value = tostring(var.trace_ingestion_batch_size) },
      { name = "TRACE_INGESTION_QUIET_PERIOD_SECONDS", value = tostring(var.trace_ingestion_quiet_period_seconds) },
      { name = "LANGWATCH_CLICKHOUSE_URL", value = "http://${aws_instance.langwatch.private_ip}:8123" },
      { name = "LANGWATCH_CLICKHOUSE_USER", value = "default" },
      { name = "LANGWATCH_CLICKHOUSE_PASSWORD", value = "langwatch" },
      { name = "LANGWATCH_CLICKHOUSE_DATABASE", value = "langwatch" },
    ])
    # Empty until onboarding (audit G-1): the worker exits 1 in a VISIBLE
    # restart loop, never an idle that reads healthy.
    secrets = concat(local.mongo_secrets, [
      { name = "LANGWATCH_PROJECT_ID", valueFrom = aws_ssm_parameter.langwatch_project_id.arn },
    ])
    logConfiguration = local.log_conf["connector"]
  }])
}

resource "aws_ecs_service" "connector" {
  name            = "${local.name}-connector"
  cluster         = local.fdn.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.connector.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Stop old, then start new — never two watermark writers.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets         = local.fdn.private_subnet_ids
    security_groups = [aws_security_group.workers.id]
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

# ── Billing auto-close scheduler (decision 131 — ON in the factory) ──────────
# Ships as the existing daemon; the EventBridge one-shot tick stays a
# documented post-migration cleanup (decision 140).

resource "aws_ecs_task_definition" "scheduler" {
  family                   = "${local.name}-scheduler"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name        = "scheduler"
    image       = local.module_image
    command     = ["node", "dist/main/jobs/run-billing-close-scheduler.js"]
    essential   = true
    stopTimeout = 60
    environment = concat(local.base_env, [
      # Required by the module env schema (one schema, one reader) — the
      # scheduler never listens.
      { name = "SERVER_PORT", value = "3000" },
      { name = "BILLING_AUTO_CLOSE_DELAY_MINUTES", value = tostring(var.billing_auto_close_delay_minutes) },
      { name = "BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS", value = tostring(var.billing_auto_close_check_interval_seconds) },
    ])
    secrets          = local.mongo_secrets
    logConfiguration = local.log_conf["scheduler"]
  }])
}

resource "aws_ecs_service" "scheduler" {
  name            = "${local.name}-scheduler"
  cluster         = local.fdn.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.scheduler.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Singleton like the connector (a REOPENED month must never race two
  # closers).
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets         = local.fdn.private_subnet_ids
    security_groups = [aws_security_group.workers.id]
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}
