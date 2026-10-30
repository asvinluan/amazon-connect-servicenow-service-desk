# ---------------------------------------------------------------------------
# Alarms. Each is tied to a failure this function can actually produce. An alarm
# that cannot fire teaches nothing and is worse than no alarm, because it looks
# like coverage.
#
# The first two use the metrics Lambda itself publishes. The rest use custom
# metrics the function publishes through AWS Lambda Powertools (Embedded Metric
# Format lines in its own log stream, so no extra permission is needed).
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

# CloudWatch alarms cannot publish to a topic encrypted with the AWS-managed SNS
# key, so the topic uses a customer-managed key whose policy lets CloudWatch in.
resource "aws_kms_key" "alarms" {
  description             = "Encrypts the service desk alarm topic"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowAccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowCloudWatchAlarms"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "alarms" {
  name          = "alias/${var.name_prefix}-alarms"
  target_key_id = aws_kms_key.alarms.key_id
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name_prefix}-alarms"
  kms_master_key_id = aws_kms_key.alarms.arn
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
  # An email subscription stays "pending confirmation" until you click the link
  # in the confirmation email. Terraform reports success either way.
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name        = "${var.name_prefix}-servicedesk-errors"
  alarm_description = "The service desk Lambda is throwing (a bug, or a temporary ServiceNow problem on a call-ended event)."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  statistic   = "Sum"
  period      = 300

  dimensions = {
    FunctionName = aws_lambda_function.servicedesk.function_name
  }

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "slow" {
  alarm_name        = "${var.name_prefix}-servicedesk-slow"
  alarm_description = "p99 duration is approaching Connect's 8-second invocation ceiling. A sleeping or distant ServiceNow instance is the usual cause."

  namespace          = "AWS/Lambda"
  metric_name        = "Duration"
  extended_statistic = "p99"
  period             = 300

  dimensions = {
    FunctionName = aws_lambda_function.servicedesk.function_name
  }

  comparison_operator = "GreaterThanThreshold"
  threshold           = var.duration_alarm_ms
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "no_ticket" {
  alarm_name        = "${var.name_prefix}-servicedesk-no-ticket-logged"
  alarm_description = "Callers are getting through without a ticket: ServiceNow is down, asleep or rejecting the sign-in. Check the reason field in the function's log."

  namespace   = "AmazonConnectLab"
  metric_name = "TicketFallback"
  statistic   = "Sum"
  period      = 300

  # Powertools publishes every metric with one dimension, the service name.
  dimensions = {
    service = "servicedesk"
  }

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching" # no calls is not a failure

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "work_note_failed" {
  alarm_name        = "${var.name_prefix}-servicedesk-work-note-failed"
  alarm_description = "A call-ended note could not be added to its ticket. Nobody is waiting on this, so without the alarm nobody would know."

  namespace   = "AmazonConnectLab"
  metric_name = "WorkNoteFailed"
  statistic   = "Sum"
  period      = 300

  dimensions = {
    service = "servicedesk"
  }

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "verification_failures" {
  alarm_name        = "${var.name_prefix}-servicedesk-verification-failures"
  alarm_description = "A run of failed caller verifications: someone may be guessing customer-number digits. The audit query 'verification failures' shows which numbers."

  namespace   = "AmazonConnectLab"
  metric_name = "VerificationFailed"
  statistic   = "Sum"
  period      = 300

  dimensions = {
    service = "servicedesk"
  }

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.verification_failures_per_5_min
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
}
