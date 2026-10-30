variable "region" {
  description = "AWS region. Must be the region of the Connect instance. ap-southeast-2 (Sydney) is the closest to Melbourne."
  type        = string
  default     = "ap-southeast-2"
}

variable "connect_instance_id" {
  description = "ID of an EXISTING Amazon Connect instance (the UUID at the end of its ARN, shown in the Connect console under Overview). This lab adds a flow and a Lambda to that instance. It does not create or change the instance itself."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.connect_instance_id))
    error_message = "connect_instance_id must be the instance UUID, for example 12345678-1234-1234-1234-123456789012 (not the alias, not the whole ARN)."
  }
}

variable "queue_name" {
  description = "Name of an EXISTING queue on that instance. Callers who finish in the flow are transferred here."
  type        = string
  default     = "lab-queue-general"
}

variable "name_prefix" {
  description = "Prefix for everything this lab creates, so it is easy to find and to remove."
  type        = string
  default     = "lab-sd"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name_prefix))
    error_message = "Use 3 to 21 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "secret_name" {
  description = "Name of the Secrets Manager secret holding the ServiceNow sign-in (JSON). Created by hand with scripts/store-secret, never by Terraform, so the values never enter the repository or the state file."
  type        = string
  default     = "lab/servicedesk"
}

variable "timeout_seconds" {
  description = "Timeout for the Lambda. It makes up to three calls to a developer instance (plus a token call under OAuth), so it needs more room than a Python lookup, but it must stay under Connect's own 8-second invocation limit."
  type        = number
  default     = 7

  validation {
    condition     = var.timeout_seconds >= 3 && var.timeout_seconds < 8
    error_message = "Must be at least 3 and under 8 seconds. Connect abandons a flow Lambda invocation at 8 seconds and takes the Error branch."
  }
}

variable "log_retention_days" {
  description = "How long the function's log (which holds the audit events) is kept. 90 is a lab figure. A bank would keep audit evidence far longer, in a locked bucket, and ship it there."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "CloudWatch Logs only accepts certain retention periods (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365 ...)."
  }
}

variable "duration_alarm_ms" {
  description = "Alarm threshold on Lambda p99 duration. Set below the Connect 8s ceiling so the alarm fires before callers start hitting the Error branch."
  type        = number
  default     = 6000
}

variable "verification_failures_per_5_min" {
  description = "Alarm when this many caller verifications fail inside five minutes. One typo is normal; a run of them is someone guessing digits."
  type        = number
  default     = 5
}

variable "alarm_email" {
  description = "Email address subscribed to the alarm topic. Empty creates the topic with no subscription."
  type        = string
  default     = ""
}
