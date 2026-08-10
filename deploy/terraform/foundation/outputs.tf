# Everything the tenant module (Phase 2) consumes, read via
# terraform_remote_state — the foundation's outputs ARE its contract.
output "region" {
  value = var.region
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "nat_egress_ip" {
  description = "The single egress IP — what Atlas network access must allowlist."
  value       = aws_eip.nat.public_ip
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

output "alb_arn" {
  value = aws_lb.main.arn
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "alb_zone_id" {
  value = aws_lb.main.zone_id
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "https_listener_arn" {
  description = "Tenant modules attach their host-header rules here."
  value       = aws_lb_listener.https.arn
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

output "github_ci_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository variable in GitHub."
  value       = aws_iam_role.github_ci.arn
}
