# ---------------------------------------------------------------------------
# The service desk: one TypeScript Lambda, one contact flow, one call-ended rule.
#
# This lab ADDS to an Amazon Connect instance you already have. It looks the
# instance and queue up (data sources) and creates only:
#   - a Lambda, its role and its log group
#   - the permission that lets Connect call the Lambda (the association)
#   - the contact flow, "<prefix>-service-desk-flow"
#   - an EventBridge rule that adds a note to the ticket when a call ends
#   - OPTIONAL (lens_route_enabled = true): a second EventBridge rule that sends
#     Contact Lens rule matches (Negative-Sentiment and so on) to the same Lambda
#   - alarms, a notification topic and saved audit queries (alarms.tf, audit.tf)
# Nothing already on the instance is modified.
#
# Unlike a Python Lambda there is a build step. The TypeScript is bundled into
# lambda/servicedesk/dist/index.js (npm run build) and Terraform zips that folder.
# Run the build BEFORE terraform plan or apply, or the zip step fails. The plan
# script in scripts/ does it for you.
#
# The ServiceNow sign-in lives in AWS Secrets Manager. Terraform only READS the
# secret's address (a data source fetches metadata, never the value) so the
# function's role can be scoped to exactly that one secret. Create the secret
# first with scripts/store-secret.
# ---------------------------------------------------------------------------

data "aws_connect_instance" "this" {
  instance_id = var.connect_instance_id
}

data "aws_connect_queue" "target" {
  instance_id = var.connect_instance_id
  name        = var.queue_name
}

data "aws_secretsmanager_secret" "servicedesk" {
  name = var.secret_name
}

data "archive_file" "servicedesk" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/servicedesk/dist"
  output_path = "${path.module}/build/servicedesk.zip"
}

resource "aws_cloudwatch_log_group" "servicedesk" {
  name              = "/aws/lambda/${var.name_prefix}-servicedesk"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "servicedesk" {
  name = "${var.name_prefix}-servicedesk"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "servicedesk" {
  name = "servicedesk-policy"
  role = aws_iam_role.servicedesk.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.servicedesk.arn}:*"
      },
      {
        Sid    = "ReadServiceNowSecret"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        # One action on one secret. No secretsmanager:*, no Resource "*".
        Resource = data.aws_secretsmanager_secret.servicedesk.arn
      },
    ]
  })
}

resource "aws_lambda_function" "servicedesk" {
  function_name = "${var.name_prefix}-servicedesk"
  role          = aws_iam_role.servicedesk.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.servicedesk.output_path
  source_code_hash = data.archive_file.servicedesk.output_base64sha256

  # The handler gives itself a 6-second budget and hands each outbound call what
  # is left of it (never more than 3 seconds). This is the hard backstop and
  # stays under Connect's 8-second ceiling (see the variable validation).
  timeout     = var.timeout_seconds
  memory_size = 256

  environment {
    variables = {
      SERVICENOW_SECRET_ID        = data.aws_secretsmanager_secret.servicedesk.name
      SERVICENOW_CALL_TIMEOUT_SEC = "3"
      SERVICENOW_TOTAL_BUDGET_SEC = "6"
      # Empty switches the Contact Lens route off inside the function as well.
      LENS_TICKET_RULES            = var.lens_route_enabled ? join(",", var.lens_ticket_rules) : ""
      POWERTOOLS_SERVICE_NAME      = "servicedesk"
      POWERTOOLS_METRICS_NAMESPACE = "AmazonConnectLab"
      POWERTOOLS_LOG_LEVEL         = "INFO"
    }
  }

  depends_on = [aws_cloudwatch_log_group.servicedesk]
}

# The call-ended event reaches this function ASYNCHRONOUSLY (EventBridge does not
# wait for an answer), so there is no caller to return an error to. Lambda
# retries a failed run twice. The function throws only for temporary problems, so
# a bad secret does not retry; the work-note alarm tells you.
resource "aws_lambda_function_event_invoke_config" "servicedesk" {
  function_name                = aws_lambda_function.servicedesk.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 3600
}

# ---------------------------------------------------------------------------
# Call ended -> work note on the ticket.
#
# Amazon Connect publishes a contact event to the default EventBridge bus when a
# call is disconnected. Nothing has to be switched on for that. The rule is
# narrow: this instance only, voice only, DISCONNECTED only.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "call_ended" {
  name        = "${var.name_prefix}-servicedesk-call-ended"
  description = "Amazon Connect voice contact disconnected: add a work note to the ServiceNow ticket the call made."

  event_pattern = jsonencode({
    source        = ["aws.connect"]
    "detail-type" = ["Amazon Connect Contact Event"]
    detail = {
      eventType   = ["DISCONNECTED"]
      channel     = ["VOICE"]
      instanceArn = [data.aws_connect_instance.this.arn]
    }
  })
}

resource "aws_cloudwatch_event_target" "call_ended" {
  rule = aws_cloudwatch_event_rule.call_ended.name
  arn  = aws_lambda_function.servicedesk.arn
}

resource "aws_lambda_permission" "call_ended" {
  statement_id  = "AllowEventBridgeCallEnded"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.servicedesk.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.call_ended.arn
}

# ---------------------------------------------------------------------------
# Contact Lens rule matched -> note on the ticket, or a new incident.
#
# A Contact Lens rule (a category such as Negative-Sentiment) can publish an
# EventBridge event when it matches. This rule sends those events to the same
# Lambda. OFF by default, so the original 22-resource plan is unchanged; turn it
# on with  lens_route_enabled = true  (3 more resources).
#
# AWS documents the event name two ways ("conversational analytics ..." in the
# Connect administrator guide, "Contact Lens ..." in the EventBridge reference),
# so the pattern lists both. The first live run records which one arrives.
# The function also checks the rule name against var.lens_ticket_rules.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "lens_rules_matched" {
  count = var.lens_route_enabled ? 1 : 0

  name        = "${var.name_prefix}-servicedesk-lens-rule-matched"
  description = "A Contact Lens rule matched a call: note the call's ServiceNow ticket, or open an incident."

  event_pattern = jsonencode({
    source = ["aws.connect"]
    "detail-type" = [
      "conversational analytics Post Call Rules Matched",
      "Contact Lens Post Call Rules Matched",
      "conversational analytics Realtime Rules Matched",
      "Contact Lens Realtime Rules Matched",
    ]
    detail = {
      instanceArn = [data.aws_connect_instance.this.arn]
      ruleName    = var.lens_ticket_rules
    }
  })
}

resource "aws_cloudwatch_event_target" "lens_rules_matched" {
  count = var.lens_route_enabled ? 1 : 0

  rule = aws_cloudwatch_event_rule.lens_rules_matched[0].name
  arn  = aws_lambda_function.servicedesk.arn
}

resource "aws_lambda_permission" "lens_rules_matched" {
  count = var.lens_route_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeLensRules"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.servicedesk.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.lens_rules_matched[0].arn
}

# ---------------------------------------------------------------------------
# The contact flow.
#
# The association is the hard requirement: it adds the resource-based policy that
# lets connect.amazonaws.com invoke the function, scoped to this instance.
# Without it the Invoke block fails at runtime with no obvious error.
# ---------------------------------------------------------------------------

resource "aws_connect_lambda_function_association" "servicedesk" {
  instance_id  = data.aws_connect_instance.this.id
  function_arn = aws_lambda_function.servicedesk.arn
}

resource "aws_connect_contact_flow" "servicedesk" {
  instance_id = data.aws_connect_instance.this.id
  name        = "${var.name_prefix}-service-desk-flow"
  description = "Inbound service desk: report a problem, ask for something, or check a ticket. ServiceNow incidents and requests, with caller verification."
  type        = "CONTACT_FLOW"

  content = templatefile("${path.module}/flows/servicedesk.json.tftpl", {
    lambda_arn = aws_lambda_function.servicedesk.arn
    queue_arn  = data.aws_connect_queue.target.arn
  })

  depends_on = [aws_connect_lambda_function_association.servicedesk]
}
