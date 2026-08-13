# One ECS cluster; every tenant's services run in it (isolation is
# per-service + per-security-group, not per-cluster — decision 140).
resource "aws_ecs_cluster" "main" {
  name = "usage-main"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]
}

# Images are built ONCE per git SHA and shared by every tenant.
# IMMUTABLE tags: a SHA can never be overwritten — rollback is repointing
# a service to yesterday's tag (decision 140; kills the clobber class).
# LEGACY names — kept until ADR-103 step B (CI now pushes canonical only).
resource "aws_ecr_repository" "images" {
  for_each = toset(["platform-module", "platform-connector", "usage-db-backup"])

  name                 = each.key
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "images" {
  for_each = aws_ecr_repository.images

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      # 200 not 50 (review fix): repos are FLEET-shared — a tenant pinned
      # to an old SHA must not lose its image to other tenants' deploy
      # cadence (expiry strikes on the next task restart, uncorrelated
      # with any operator action). ~$6/repo/mo at typical image sizes;
      # the deploy script separately refuses SHAs absent from ECR.
      description = "keep the last 200 images (every kept SHA stays deployable)"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 200
      }
      action = { type = "expire" }
    }]
  })
}

# ADR-103 R8 (four-axis): khal/<tenant>/<env>/<image>. The tenant axis is the
# OPERATING tenant (namastex — this account runs namastex's usage product for
# its clients); images stay fleet-shared, built once per SHA.
locals {
  canonical_images = {
    "usage-module"    = "khal/namastex/production/usage-module"
    "usage-connector" = "khal/namastex/production/usage-connector"
    "usage-db-backup" = "khal/namastex/production/usage-db-backup"
  }
}

resource "aws_ecr_repository" "images_v2" {
  for_each = local.canonical_images

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "images_v2" {
  for_each = aws_ecr_repository.images_v2

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 200 images (every kept SHA stays deployable)"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 200
      }
      action = { type = "expire" }
    }]
  })
}
