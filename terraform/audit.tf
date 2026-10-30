# ---------------------------------------------------------------------------
# The audit trail: saved CloudWatch Logs Insights queries.
#
# The Lambda writes one structured log line per decision (auditEvent plus a
# closed list of safe fields, see lambda/servicedesk/src/telemetry.ts). These
# saved queries turn those lines into answers. They appear in the console under
# CloudWatch > Logs Insights > Queries > Saved queries.
#
# This is a lab-grade audit trail: it lives in an ordinary log group that anyone
# with log access can read and an administrator can delete. A bank would also ship
# these events to a write-once store. docs/BUILD-MANUAL.md says what and why.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_query_definition" "audit_by_contact" {
  name            = "${var.name_prefix}/audit trail for one contact"
  log_group_names = [aws_cloudwatch_log_group.servicedesk.name]

  # Replace PASTE-CONTACT-ID with the contact id from the Connect contact search.
  query_string = <<-EOT
    fields @timestamp, auditEvent, reason, ticketType, ticketNumber, callerLast4
    | filter contactId = "PASTE-CONTACT-ID" and ispresent(auditEvent)
    | sort @timestamp asc
  EOT
}

resource "aws_cloudwatch_query_definition" "verification_failures" {
  name            = "${var.name_prefix}/verification failures"
  log_group_names = [aws_cloudwatch_log_group.servicedesk.name]

  query_string = <<-EOT
    fields @timestamp, contactId, callerLast4, reason
    | filter auditEvent = "verification_failed"
    | sort @timestamp desc
    | limit 100
  EOT
}

resource "aws_cloudwatch_query_definition" "tickets_by_type" {
  name            = "${var.name_prefix}/tickets created by type and day"
  log_group_names = [aws_cloudwatch_log_group.servicedesk.name]

  query_string = <<-EOT
    filter auditEvent in ["incident_created", "request_created"]
    | stats count(*) as tickets by auditEvent, bin(1d)
    | sort bin(1d) desc
  EOT
}

resource "aws_cloudwatch_query_definition" "refused_status_checks" {
  name            = "${var.name_prefix}/status checks refused"
  log_group_names = [aws_cloudwatch_log_group.servicedesk.name]

  # not_owner means a verified caller asked about somebody else's ticket.
  query_string = <<-EOT
    fields @timestamp, contactId, callerLast4, reason, ticketType
    | filter auditEvent = "status_refused"
    | sort @timestamp desc
    | limit 100
  EOT
}
