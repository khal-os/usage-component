# Nightly mongodump → S3 (decision 140). On Atlas Flex/M0 this is the ONLY
# backup of the permanent archive — and a backup job that fails silently is
# worse than none, so failure is wired to the alert topic.

resource "aws_ecs_task_definition" "backup" {
  family                   = "${local.name}-backup"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.backup_task.arn

  container_definitions = jsonencode([{
    name      = "backup"
    image     = local.backup_image
    essential = true
    environment = concat(local.mongo_env, [
      { name = "BACKUP_BUCKET", value = local.fdn.backups_bucket_name },
      { name = "BACKUP_PREFIX", value = var.client_name },
    ])
    secrets          = local.mongo_secrets
    logConfiguration = local.log_conf["backup"]
  }])
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup_schedule" {
  name               = "${local.name}-backup-schedule"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "backup_run_task" {
  statement {
    actions = ["ecs:RunTask"]
    # BOTH ARN forms (review fix): the schedule passes the REVISION-LESS
    # ARN, and IAM matches the ARN as called — family:* alone would
    # AccessDeny every single 07:00 fire, silently.
    resources = [
      aws_ecs_task_definition.backup.arn_without_revision,
      "${aws_ecs_task_definition.backup.arn_without_revision}:*",
    ]
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.backup_task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "backup_schedule" {
  name   = "run-backup-task"
  role   = aws_iam_role.backup_schedule.id
  policy = data.aws_iam_policy_document.backup_run_task.json
}

resource "aws_scheduler_schedule" "backup" {
  name = "${local.name}-backup"
  # 07:00 UTC ≈ 04:00 America/Sao_Paulo — after any month-close activity.
  schedule_expression = "cron(0 7 * * ? *)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = local.fdn.ecs_cluster_arn
    role_arn = aws_iam_role.backup_schedule.arn

    ecs_parameters {
      # Revision-less ARN = latest ACTIVE revision, so the deploy script's
      # image bumps take effect without touching the schedule.
      task_definition_arn = aws_ecs_task_definition.backup.arn_without_revision
      launch_type         = "FARGATE"

      network_configuration {
        subnets         = aws_subnet.private[*].id
        security_groups = [aws_security_group.workers.id]
      }
    }
  }
}

# THE backstop (review fix): a daily Succeeded=1 metric published by the
# entrypoint after a verified upload; a day with NO datapoint alarms.
# This covers every silent mode at once — RunTask denied (no ECS event),
# image-pull failure (no exitCode on the event), truncated dump (task
# exits 1 before publishing), schedule misfire.
resource "aws_cloudwatch_metric_alarm" "backup_missing" {
  alarm_name          = "${local.name}-backup-missing"
  alarm_description   = "No successful backup in >1 day — on Flex/M0 this is the ONLY backup of the permanent archive."
  namespace           = "Usage/Backup"
  metric_name         = "Succeeded"
  dimensions          = { Tenant = var.client_name }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = [local.fdn.alerts_topic_arn]
  ok_actions    = [local.fdn.alerts_topic_arn]
}

# Failure → immediate alert: any STOPPED backup task with a non-zero exit
# code (fast signal; the metric alarm above is the completeness backstop —
# events without an exitCode don't match this pattern).
resource "aws_cloudwatch_event_rule" "backup_failed" {
  name = "${local.name}-backup-failed"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      lastStatus = ["STOPPED"]
      group      = ["family:${aws_ecs_task_definition.backup.family}"]
      containers = { exitCode = [{ anything-but = 0 }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "backup_failed" {
  rule = aws_cloudwatch_event_rule.backup_failed.name
  arn  = local.fdn.alerts_topic_arn

  input_transformer {
    input_paths = {
      group  = "$.detail.group"
      reason = "$.detail.stoppedReason"
    }
    input_template = "\"BACKUP FAILED <group>: <reason> — the permanent archive has no fresh dump (tenant ${var.client_name})\""
  }
}
