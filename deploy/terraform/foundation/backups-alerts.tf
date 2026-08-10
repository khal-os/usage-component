# Shared backup bucket (per-tenant prefixes) + the one alert topic every
# tenant's alarms publish to (decision 140).

resource "aws_s3_bucket" "backups" {
  bucket = "usage-backups-${data.aws_caller_identity.current.account_id}"
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  # Dailies stay hot 35 days, then Glacier; expired after ~13 months.
  # Versioning + lifecycle beat clever tiering — restores must be boring.
  rule {
    id     = "age-out"
    status = "Enabled"

    filter {}

    transition {
      days          = 35
      storage_class = "GLACIER"
    }

    expiration {
      days = 400
    }
  }
}

resource "aws_sns_topic" "alerts" {
  name = "usage-alerts"
}

# Whoever operates the fleet subscribes (email confirm is a manual click):
#   aws sns subscribe --topic-arn <arn> --protocol email --notification-endpoint you@x
# EventBridge (backup-failure rules in tenant stacks) must be allowed to publish.
data "aws_iam_policy_document" "alerts_topic" {
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com", "cloudwatch.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}
