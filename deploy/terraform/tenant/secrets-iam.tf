# Tenant secrets (the [SECRET→SM] contract from clients/example.production.env).
# ADR-103: one JSON secret per FAMILY at khal/<client>/<env>/usage/{mongo,
# langwatch}, keys == env var names. Terraform creates the SHELLS;
# VALUES are set by the operator (RUNBOOK-AWS.md §onboarding) or by
# deploy/scripts/migrate-adr103.sh (which splits the legacy usage/<client>
# JSON, renaming LW_* keys to LANGWATCH_*) and never transit state or git:
#   aws secretsmanager put-secret-value \
#     --secret-id khal/<client>/<env>/usage/mongo \
#     --secret-string '{"MONGO_DB_HOST":"...","MONGO_DB_USER":"...","MONGO_DB_PASSWORD":"..."}'
# ── Canonical secrets (ADR-103): khal/<client>/<env>/usage/<family> ─────────
# One JSON secret per family, keys == the env var names (R2). Terraform
# creates the SHELL with an empty JSON; VALUES come from the operator or the
# migrate-adr103.sh script (which splits the legacy JSON and renames the
# LW_* keys to LANGWATCH_*) — never through state or git.
resource "aws_secretsmanager_secret" "usage" {
  # basic-auth left this set with the session-auth switch (decision 141
  # retired): the khal/<client>/<env>/usage/basic-auth secret is no longer
  # read by anything and can be deleted by the operator.
  for_each = toset(["mongo", "langwatch"])

  name = "${local.sm_base}/${each.key}"
}

resource "aws_secretsmanager_secret_version" "usage_seed" {
  for_each = aws_secretsmanager_secret.usage

  secret_id     = each.value.id
  secret_string = "{}"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# LANGWATCH_PROJECT_ID starts EMPTY on purpose (audit G-1): the connector
# exits 1 in a visible restart loop until onboarding writes the real value
# (runbook) — never an idle that reads healthy.
# LANGWATCH_PROJECT_ID starts EMPTY on purpose (audit G-1): the connector
# exits 1 in a visible restart loop until onboarding writes the real value.
resource "aws_ssm_parameter" "langwatch_project_id_v2" {
  name  = "${local.ssm_base}/langwatch-project-id"
  type  = "String"
  value = " " # placeholder — set by onboarding/migration; ignore drift below

  lifecycle {
    ignore_changes = [value]
  }
}

# ── ECS roles ────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: what the ECS AGENT needs before the container runs —
# pull from ECR, write logs, inject the secret/parameter values.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.usage : s.arn]
  }

  statement {
    actions   = ["ssm:GetParameters"]
    resources = [aws_ssm_parameter.langwatch_project_id_v2.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-tenant-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task role: what the CODE may do. The app tasks talk only to Mongo/
# ClickHouse over the network — empty role, present so nothing ever runs
# with a shared default.
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# Backup task role: the one task that touches AWS APIs (S3 upload).
resource "aws_iam_role" "backup_task" {
  name               = "${local.name}-backup-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "backup_s3" {
  statement {
    # tmp-key upload + rename-on-success (review fix: a truncated dump
    # must never sit at a normal-looking key). backups/ prefix matches
    # the lifecycle rule's scope (audit round 2); AbortMultipartUpload
    # lets a failed streaming upload clean its own parts.
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      # `aws s3 mv` (the rename-on-success) copies tagging with the object;
      # without these the dump succeeds but the rename dies AccessDenied
      # (found live 2026-08-11, first sa-east-1 backup run).
      "s3:GetObjectTagging",
      "s3:PutObjectTagging",
    ]
    resources = ["${local.fdn.backups_bucket_arn}/backups/${var.client_name}/*"]
  }

  statement {
    # The success heartbeat the 25h backstop alarm watches.
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Usage/Backup"]
    }
  }
}

resource "aws_iam_role_policy" "backup_s3" {
  name   = "backup-put"
  role   = aws_iam_role.backup_task.id
  policy = data.aws_iam_policy_document.backup_s3.json
}

# ── Log groups (one per service, tenant-prefixed) ────────────────────────────

resource "aws_cloudwatch_log_group" "services_v2" {
  for_each = toset(["api", "connector", "scheduler", "backup"])

  name              = "${local.ssm_base}/${each.key}"
  retention_in_days = 90
}
