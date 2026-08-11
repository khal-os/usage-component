# Everything the tenant module consumes, read via terraform_remote_state —
# the foundation's outputs ARE its contract. Decision 142: no network here;
# each tenant builds its own VPC/NAT/ALB and only borrows the shared
# data-free pieces below.
output "region" {
  value = var.region
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.main.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.images : k => r.repository_url }
}

output "route53_zone_id" {
  value = aws_route53_zone.main.zone_id
}

output "route53_name_servers" {
  description = "Point the domain's registrar at these."
  value       = aws_route53_zone.main.name_servers
}

output "base_domain" {
  value = var.base_domain
}

output "wildcard_certificate_arn" {
  description = "Attached by every tenant's own ALB (validated *.base_domain)."
  value       = aws_acm_certificate_validation.wildcard.certificate_arn
}

output "backups_bucket_name" {
  value = aws_s3_bucket.backups.bucket
}

output "backups_bucket_arn" {
  value = aws_s3_bucket.backups.arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "github_ci_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository variable in GitHub."
  value       = aws_iam_role.github_ci.arn
}
