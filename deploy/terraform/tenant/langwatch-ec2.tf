# The client's OWN LangWatch stack on one EC2 (decisions 140 + 52): the
# pinned compose services mirrored from compose.connector.yml, burst-
# hardened per decision 139 (declared capacity + queue alarm). Private
# subnet — reachable only via the ALB (5560) and the connector's SG (8123).

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }
}

resource "aws_security_group" "langwatch" {
  name_prefix = "${local.name}-langwatch-"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "LangWatch app (UI + OTLP ingest) from the ALB"
    from_port       = 5560
    to_port         = 5560
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description     = "ClickHouse reads from the connector (decision 127)"
    from_port       = 8123
    to_port         = 8123
    protocol        = "tcp"
    security_groups = [aws_security_group.workers.id]
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

# Instance profile: read the tenant secret at boot, push the queue metric,
# and SSM Session Manager instead of SSH (no keys, no port 22).
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "langwatch" {
  name               = "${local.name}-langwatch"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "langwatch_ssm" {
  role       = aws_iam_role.langwatch.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "langwatch_boot" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.tenant.arn]
  }

  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Usage/LangWatch"]
    }
  }
}

resource "aws_iam_role_policy" "langwatch_boot" {
  name   = "boot-and-metrics"
  role   = aws_iam_role.langwatch.id
  policy = data.aws_iam_policy_document.langwatch_boot.json
}

resource "aws_iam_instance_profile" "langwatch" {
  name = "${local.name}-langwatch"
  role = aws_iam_role.langwatch.name
}

resource "aws_instance" "langwatch" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.langwatch_instance_type
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.langwatch.id]
  iam_instance_profile   = aws_iam_instance_profile.langwatch.name

  root_block_device {
    volume_type = "gp3"
    volume_size = var.langwatch_volume_gb
    # Snapshot selector for the DLM policy below.
    tags = {
      Name         = "${local.name}-langwatch"
      DlmSnapshots = local.name
    }
  }

  user_data = templatefile("${path.module}/templates/langwatch-user-data.sh.tftpl", {
    client_name                = var.client_name
    secret_arn                 = aws_secretsmanager_secret.tenant.arn
    region                     = var.region
    langwatch_public_url       = "https://${local.langwatch_hostname}"
    langwatch_workers_replicas = var.langwatch_workers_replicas
    langwatch_memory_limit     = var.langwatch_memory_limit
    lw_redis_memory_limit      = var.lw_redis_memory_limit
    lw_clickhouse_memory_limit = var.lw_clickhouse_memory_limit
    lw_clickhouse_cpu_limit    = var.lw_clickhouse_cpu_limit
    compose_file               = file("${path.module}/templates/langwatch-compose.yml")
  })
  user_data_replace_on_change = true

  tags = { Name = "${local.name}-langwatch" }

  lifecycle {
    # Replacing this instance wipes LangWatch's ~49-day window; the Mongo
    # store is the permanent archive, but make the operator SAY so.
    prevent_destroy = true
  }
}

# ── Edge: hostname → app port ────────────────────────────────────────────────

resource "aws_lb_target_group" "langwatch" {
  name        = substr("${local.name}-lw", 0, 32)
  port        = 5560
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "instance"

  health_check {
    path    = "/"
    matcher = "200-399"
  }
}

resource "aws_lb_target_group_attachment" "langwatch" {
  target_group_arn = aws_lb_target_group.langwatch.arn
  target_id        = aws_instance.langwatch.id
  port             = 5560
}

resource "aws_lb_listener_rule" "langwatch" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 101

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.langwatch.arn
  }

  condition {
    host_header {
      values = [local.langwatch_hostname]
    }
  }
}

resource "aws_route53_record" "langwatch" {
  zone_id = local.fdn.route53_zone_id
  name    = local.langwatch_hostname
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# ── Daily EBS snapshots (keep 7) ─────────────────────────────────────────────

data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${local.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "langwatch" {
  description        = "${local.name} langwatch daily snapshots"
  execution_role_arn = aws_iam_role.dlm.arn

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { DlmSnapshots = local.name }

    schedule {
      name = "daily"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["06:00"]
      }

      retain_rule {
        count = 7
      }
    }
  }
}

# ── The burst alarm (decision 139): redis memory IS the backlog ──────────────
# The PoC died silently — queue grew into an OOM with no signal. The
# user-data cron publishes redis used_memory; this alarm fires while a
# burst is still a backlog, not yet a corpse.

resource "aws_cloudwatch_metric_alarm" "redis_backlog" {
  alarm_name          = "${local.name}-langwatch-queue-backlog"
  alarm_description   = "LangWatch ingest queue (redis) memory climbing — a burst is backing up. UI slowness is expected; ingest death is not (decision 139)."
  namespace           = "Usage/LangWatch"
  metric_name         = "RedisUsedMemoryPercent"
  dimensions          = { Tenant = var.client_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching" # a silent metric is the failure mode we had

  alarm_actions = [local.fdn.alerts_topic_arn]
  ok_actions    = [local.fdn.alerts_topic_arn]
}
