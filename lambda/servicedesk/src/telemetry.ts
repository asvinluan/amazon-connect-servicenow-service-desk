// One logger and one metrics object for the whole function, created at import
// so a warm container reuses them.
//
// AWS Lambda Powertools writes each log line as one JSON object (easy to search
// in CloudWatch) and publishes metrics as Embedded Metric Format lines in the
// same log stream, so there is no extra API call and no extra IAM permission.
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";

export const SERVICE_NAME = "servicedesk";

export const logger = new Logger({ serviceName: SERVICE_NAME });

export const metrics = new Metrics({
  namespace: process.env.POWERTOOLS_METRICS_NAMESPACE ?? "AmazonConnectLab",
  serviceName: SERVICE_NAME,
});

export { MetricUnit };

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------
//
// An audit event answers "who did what, to which record, and was it allowed?"
// It is an ordinary log line with `audit: true` and a fixed event name, so a
// Logs Insights query can pull the whole trail for one contact.
//
// The fields are a CLOSED list. There is deliberately no field that could hold
// the digits a caller keyed in, a customer number, a full phone number, a name
// or a token: adding one would be a compile error. Callers are identified by
// the last four digits of their number and by the Amazon Connect contact id.

export type AuditEvent =
  | "caller_identified"
  | "caller_unknown"
  | "verification_passed"
  | "verification_failed"
  | "incident_created"
  | "incident_existing"
  | "request_created"
  | "request_existing"
  | "status_read"
  | "status_refused"
  | "call_ended_note"
  | "lens_ticket_created"
  | "lens_note";

export interface AuditFields {
  contactId?: string;
  /** Last four digits of the caller's number. Never more. */
  callerLast4?: string;
  /** Short machine-readable reason, such as "wrong_digits" or "not_owner". */
  reason?: string;
  ticketType?: "incident" | "request";
  ticketNumber?: string;
}

export function audit(event: AuditEvent, fields: AuditFields = {}): void {
  logger.info("audit", { audit: true, auditEvent: event, ...fields });
}
