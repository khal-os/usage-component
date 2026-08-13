output "api_url" {
  value = "https://${local.api_hostname}"
}

output "langwatch_url" {
  description = "Hand this to the client's agent platform as the OTLP endpoint base."
  value       = "https://${local.langwatch_hostname}"
}

output "nat_egress_ip" {
  description = "THIS client's egress IP — what THEIR Atlas allowlist admits (decision 142)."
  value       = aws_eip.nat.public_ip
}

output "clickhouse_private_url" {
  value = "http://${aws_route53_record.clickhouse.name}:8123"
}

output "usage_secret_arns" {
  description = "Canonical family secrets (ADR-103): khal/<client>/<env>/usage/{mongo,langwatch,basic-auth}."
  value       = { for k, s in aws_secretsmanager_secret.usage : k => s.arn }
}

output "langwatch_project_id_parameter" {
  description = "Write the real project id here after LangWatch onboarding."
  value       = aws_ssm_parameter.langwatch_project_id_v2.name
}

output "service_names" {
  value = {
    api       = aws_ecs_service.api.name
    connector = aws_ecs_service.connector.name
    scheduler = aws_ecs_service.scheduler.name
  }
}

output "backup_task_family" {
  value = aws_ecs_task_definition.backup.family
}
