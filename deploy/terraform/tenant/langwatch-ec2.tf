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

# Cross-SG references as standalone rules (review fix: inline rules
# referencing another SG deadlock its create_before_destroy replacement).
resource "aws_vpc_security_group_ingress_rule" "langwatch_from_alb" {
  description                  = "LangWatch app (UI + OTLP ingest) from the ALB"
  security_group_id            = aws_security_group.langwatch.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 5560
  to_port                      = 5560
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "langwatch_from_workers" {
  description                  = "ClickHouse reads from the connector (decision 127)"
  security_group_id            = aws_security_group.langwatch.id
  referenced_security_group_id = aws_security_group.workers.id
  from_port                    = 8123
  to_port                      = 8123
  ip_protocol                  = "tcp"
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
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.langwatch_capacity.arn]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${local.fdn.backups_bucket_arn}/config/${var.client_name}/*"]
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

# Capacity knobs live in SSM, not in user_data (review fix): a retune is
# `terraform apply` + service restart — never an instance replacement
# fighting prevent_destroy.
resource "aws_ssm_parameter" "langwatch_capacity" {
  name = "/usage/${var.client_name}/langwatch-capacity"
  type = "String"

  value = jsonencode({
    LANGWATCH_WORKERS_REPLICAS        = var.langwatch_workers_replicas
    LANGWATCH_MEMORY_LIMIT            = var.langwatch_memory_limit
    LANGWATCH_REDIS_MEMORY_LIMIT      = var.langwatch_redis_memory_limit
    LANGWATCH_CLICKHOUSE_MEMORY_LIMIT = var.langwatch_clickhouse_memory_limit
    LANGWATCH_CLICKHOUSE_CPU_LIMIT    = var.langwatch_clickhouse_cpu_limit
  })
}

# Compose file + bootstrap script are served from S3 (config prefix of the
# shared bucket) and re-fetched on EVERY service start — bugfixes deploy
# with terraform apply + restart, never instance replacement.
resource "aws_s3_object" "langwatch_compose" {
  bucket  = local.fdn.backups_bucket_name
  key     = "config/${var.client_name}/langwatch-compose.yml"
  content = file("${path.module}/templates/langwatch-compose.yml")
  etag    = filemd5("${path.module}/templates/langwatch-compose.yml")
}

resource "aws_s3_object" "langwatch_bootstrap" {
  bucket  = local.fdn.backups_bucket_name
  key     = "config/${var.client_name}/langwatch-bootstrap.sh"
  content = file("${path.module}/templates/langwatch-bootstrap.sh")
  etag    = filemd5("${path.module}/templates/langwatch-bootstrap.sh")
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

  # STABLE values only (capacity/compose/bootstrap arrive via SSM/S3 at
  # every service start) — user_data changes are structural and rare.
  user_data = templatefile("${path.module}/templates/langwatch-user-data.sh.tftpl", {
    client_name          = var.client_name
    secret_arn           = aws_secretsmanager_secret.tenant.arn
    region               = var.region
    langwatch_public_url = "https://${local.langwatch_hostname}"
    capacity_param       = aws_ssm_parameter.langwatch_capacity.name
    compose_s3_uri       = "s3://${local.fdn.backups_bucket_name}/${aws_s3_object.langwatch_compose.key}"
    bootstrap_s3_uri     = "s3://${local.fdn.backups_bucket_name}/${aws_s3_object.langwatch_bootstrap.key}"
  })
  user_data_replace_on_change = false

  tags = { Name = "${local.name}-langwatch" }

  # Review fix: user-data's first boot needs EGRESS (dnf, github, S3, SM)
  # — the NAT and private route must exist before the instance boots, or
  # the once-only install dies with no route. (The per-boot service
  # retries, but docker/compose install is once-only.)
  depends_on = [aws_route_table_association.private, aws_nat_gateway.main]

  lifecycle {
    # Replacing this instance wipes LangWatch's ~49-day window; the Mongo
    # store is the permanent archive, but make the operator SAY so.
    prevent_destroy = true
    # Audit round 2: most_recent AMI re-resolves every plan; a new AL2023
    # release would otherwise plan a replacement that prevent_destroy
    # turns into a hard error — blocking EVERY apply within weeks.
    # Patching the box's base image is a deliberate act (targeted
    # -replace after lifting prevent_destroy), not a side effect.
    ignore_changes = [ami]
  }
}

# ── Stable in-VPC name for ClickHouse (review fix) ───────────────────────────
# The connector's env points here, not at a hardcoded private IP: if the
# instance is ever replaced, terraform updates this record and the RUNNING
# connector keeps working — no task-definition churn, no stale-IP window
# (services ignore task_definition by design).

resource "aws_route53_zone" "internal" {
  name = "internal.usage"

  vpc {
    vpc_id = aws_vpc.main.id
  }
}

resource "aws_route53_record" "clickhouse" {
  zone_id = aws_route53_zone.internal.zone_id
  name    = "clickhouse.internal.usage"
  type    = "A"
  ttl     = 60
  records = [aws_instance.langwatch.private_ip]
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
