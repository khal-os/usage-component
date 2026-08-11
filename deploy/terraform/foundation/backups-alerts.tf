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

  # SCOPED to backups/* (audit round 2): an unfiltered rule also governed
  # the config/<client>/ objects the LangWatch EC2 fetches on every
  # service start — their day-400 delete marker would have bricked every
  # later boot. Dailies: hot 35 days → Glacier → delete marker at 400d;
  # noncurrent versions (the bucket is versioned — "deleted" bytes
  # otherwise live forever, billed) are truly expired after 35 more days;
  # abandoned multipart parts (a failed streaming upload) are aborted.
  rule {
    id     = "age-out-backups"
    status = "Enabled"

    filter {
      prefix = "backups/"
    }

    transition {
      days          = 35
      storage_class = "GLACIER"
    }

    expiration {
      days = 400
    }

    noncurrent_version_expiration {
      noncurrent_days = 35
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
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

    # Review fix: without this, ANY AWS account's EventBridge/CloudWatch
    # could publish spoofed alerts to the fleet topic.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}
