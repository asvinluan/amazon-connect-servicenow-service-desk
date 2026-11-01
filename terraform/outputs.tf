output "flow_name" {
  description = "The contact flow this lab created. Attach a phone number to it, or use the flow's Test button."
  value       = aws_connect_contact_flow.servicedesk.name
}

output "function_name" {
  description = "The service desk Lambda. Test it from the Lambda console, or run scripts/invoke-test (it reads this)."
  value       = aws_lambda_function.servicedesk.function_name
}

output "log_group" {
  description = "Where the function logs, audit events included."
  value       = aws_cloudwatch_log_group.servicedesk.name
}

output "lens_route" {
  description = "Whether the Contact Lens route is on, and the rule names allowed to open or note a ticket."
  value       = var.lens_route_enabled ? "on: ${join(", ", var.lens_ticket_rules)}" : "off (set lens_route_enabled = true to turn it on)"
}

output "alarm_topic_arn" {
  description = "SNS topic the alarms publish to."
  value       = aws_sns_topic.alarms.arn
}

output "next_steps" {
  description = "What still needs a human."
  value       = <<-EOT
    1. Create the test users in ServiceNow (docs/BUILD-MANUAL.md, section 4), then run scripts/invoke-test.
    2. In the Connect console open Routing > Flows > ${aws_connect_contact_flow.servicedesk.name} > Test, or attach a phone number to it.
    3. Look at the audit trail: CloudWatch > Logs Insights > Saved queries > ${var.name_prefix}/...
  EOT
}
