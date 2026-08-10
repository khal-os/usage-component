output "api_url" {
  value = "https://${local.api_hostname}"
}

output "langwatch_url" {
  description = "Hand this to the client's agent platform as the OTLP endpoint base."
  value       = "https://${local.langwatch_hostname}"
}

output "clickhouse_private_url" {
  value = "http://${aws_instance.langwatch.private_ip}:8123"
}

output "tenant_secret_arn" {
  description = "Fill via `aws secretsmanager put-secret-value` (RUNBOOK-AWS.md)."
  value       = aws_secretsmanager_secret.tenant.arn
}

output "langwatch_project_id_parameter" {
  description = "Write the real project id here after LangWatch onboarding."
  value       = aws_ssm_parameter.langwatch_project_id.name
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
