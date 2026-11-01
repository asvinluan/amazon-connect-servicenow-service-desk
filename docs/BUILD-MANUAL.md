# Amazon Connect service desk with ServiceNow: build manual

**Lab work, labelled as a design.** Built in my own AWS account and a free ServiceNow Personal Developer Instance (PDI). No employer or client system, no real customer data. Phone numbers and customer numbers are fictional (03 5550 xxxx, CUST-4820xxxx).

This is the second version of my ServiceNow lab. The first (`amazon-connect-lab`, folder `scripts/servicenow`) creates an incident when someone calls. This one is designed the way a regulated business would run it: the caller is verified before anything private is said, requests are handled as well as incidents, ServiceNow is reached with OAuth 2.0, and every step leaves an audit record the agent and the auditor can read.

The commands are in two separate runbooks (pick one):

* `RUNBOOK-POWERSHELL.md` - Windows PowerShell
* `RUNBOOK-BASH.md` - Git Bash, WSL, Linux, macOS

> **Plain-English box.** Lines that start with "In plain English" are the easy version. Read those first if the rest is heavy.

---

## 1. What it does

A caller phones the lab Connect instance. The flow looks at the caller's number quietly (nothing is said about it) and plays a menu.

| Press | What happens |
|-|-|
| 1 | **Report a problem.** Caller picks the kind (software, network, other) and whether it stops them working. An **incident** is created, the number is read back twice, and the caller is queued. No verification is needed to report a problem. |
| 2 | **Ask for something.** Only for numbers ServiceNow recognises. Caller picks access, equipment or general information, then keys the **last 4 digits of the customer number**. A **request** (REQ) is created. |
| 3 | **Check a ticket.** Only for recognised numbers. Caller picks incident or request, keys the 7-digit ticket number, then the last 4 digits of the customer number. They hear the state, for example "In Progress". |
| 0 | An agent. |

When the call ends, a second path writes a **work note** on the ticket ("call ended"). The agent opens a ticket that already exists, with the call summary on it.

Every failure path ends with the caller reaching an agent (or a polite goodbye after a finished status check). ServiceNow being down must never mean a caller is dropped.

> In plain English: the phone call makes the ticket before a person picks up. Private things (the state of a ticket, a new request) are only handled after the caller proves they know part of their customer number.

## 2. How it fits together

```text
Caller -> Connect flow  <prefix>-service-desk-flow
            |  invokes (8 second ceiling in Connect)
            v
        Lambda "servicedesk" (TypeScript, Node 22, arm64)
            |-- Secrets Manager  lab/servicedesk (instance, auth mode, id/secret)
            |-- ServiceNow  oauth_token.do   (OAuth 2.0 client credentials)
            |-- ServiceNow Table API  sys_user   (who is this number?)
            |-- ServiceNow Table API  incident, sc_request (find, create, state)
            v
        flat map of strings back to the flow:
        status, reason, ticketType, ticketNumber, ticketSpoken, agentSummary,
        statusText, callerKnown, callerMatch

Call ends -> EventBridge (DISCONNECTED, VOICE) -> same Lambda -> work note
Every decision -> one audit log line (JSON) -> CloudWatch Logs -> saved queries
Problems -> CloudWatch alarms -> SNS topic (own KMS key) -> optional email
```

The Lambda has four actions, chosen by a parameter the flow sends:

| Action | Used by | Needs verification |
|-|-|-|
| `identify` | start of every call | no (and it never reveals the name to the caller) |
| `create_incident` | menu 1 | no |
| `create_request` | menu 2 | **yes** |
| `status` | menu 3 | **yes**, then the ticket must belong to the caller |

## 3. The design decisions (the interview answers)

**Caller verification.**
* The caller's phone number (ANI) can be spoofed, so it only suggests who is calling. It never proves it.
* Proof is the last 4 digits of the customer number, keyed on the phone. The check happens in the same Lambda call as the lookup, so the full number never travels back to the flow.
* The caller's name is never spoken before verification. The agent sees it later in `callerMatch`.
* "Number not recognised" and "ticket not yours" give the same spoken answer as "ticket does not exist". A caller cannot learn which tickets exist.
* The digits are never logged, stored or returned. The audit record keeps the last 4 digits of the phone number only.
* Comparison uses `timingSafeEqual`.

**Requests as well as incidents.** An incident means "something is broken" (table `incident`, INC numbers). A request means "I want something" (table `sc_request`, REQ numbers). Requests carry `requested_for`, so the right person is on the record, and a work note saying how the caller was verified.

**OAuth 2.0 instead of a password.** The Lambda asks `/oauth_token.do` for a short-lived token using a client ID and secret (client credentials). If ServiceNow answers 401, it fetches a new token and retries once. If the grant is not switched on in your instance, the secret can hold a basic-auth user instead (`auth: basic`), and everything else behaves the same. Several simultaneous calls share one token request.

**Idempotent create.** The Connect contact id goes into `correlation_id`. Before creating, the Lambda looks for a ticket with that id. A retry returns the same ticket.

**Time budget.** 3 seconds per ServiceNow call and 6 seconds in total (defaults), with the Lambda's own timeout at 7 seconds as the hard backstop, all inside Connect's 8 seconds.

**Degrade, do not fail.** Every error returns `status` and a `reason` code. The flow apologises and queues the caller.

**Audit trail.** Every decision writes one structured line with a closed list of fields: `contactId`, `auditEvent`, `ticketType`, `ticketNumber`, `reason`, `callerLast4`. Four saved Logs Insights queries turn the log into an audit view (section 8).

**Least privilege.** The ServiceNow integration user has `itil` (and `sn_request_write` if requests are refused), web-service-access-only. The Lambda role can read one secret and write its own logs. The alarm topic uses a customer-managed KMS key.

> In plain English: the phone number says who might be calling. The last four digits prove it. Until then, the lab says nothing private.

## 4. Install the tools and set up ServiceNow (once)

**Tools.** Open **PowerShell** (not as administrator):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Amazon.AWSCLI
winget install Hashicorp.Terraform
winget install Git.Git
```

Close and reopen PowerShell. Check: `node --version` (22 or newer), `npm.cmd --version`, `aws --version`, `terraform version`, `git --version`. Use `npm.cmd`, not `npm`, in PowerShell: Windows blocks `npm.ps1` with "running scripts is disabled", and `npm.cmd` avoids that without changing any security setting.

TypeScript itself is installed by the project (`npm ci` puts TypeScript, vitest and esbuild in `lambda/servicedesk/node_modules`, which git ignores). You only need Node.

**Amazon Connect.** You need an **existing** Connect instance in your own AWS account, with a queue (default name `lab-queue-general`; change `queue_name` if yours differs). This lab only reads them; it never creates or deletes the instance. Its ID is the last part of the instance ARN (Connect console > your instance > Overview).

**ServiceNow (free PDI).** Do this in your own developer instance. If it has been idle it hibernates: wake it at developer.servicenow.com and wait a few minutes.

*4.1 Integration user*

1. All > User Administration > Users > New.
2. User ID `svc_connect_lab`, first name `Connect`, last name `Lab Integration`.
3. Older releases: tick **Web service access only**. Newer releases (seen 30 Oct 2026) have no such box, only **Identity type** and **Internal Integration User**; leave both as they are, the lab does not need them. Make sure **Active** is ticked and **Locked out** is not.
4. Password. Newer releases only let you **generate** one: **Set Password > Generate**, use the copy button, **Save Password**, then paste it into the hidden prompt of `store-secret`. Saving ticks **Password needs reset** by itself: **untick it and click Update**, or the API refuses the user. Never screenshot or paste the password.
5. Roles tab > Edit > add `itil`, `snc_platform_rest_api_access` and **`snc_basic_auth_api_access`**. The last one is what lets a Basic sign-in reach the API on newer releases; without it the API answers 401 "User is not authenticated" even though the browser login works.
6. To create requests you also need more than `itil`. `sn_request_write` alone gave 403 "ACL Exception Insert Failed" in the first live run; adding `catalog_admin` made request creation work. `catalog_admin` is broader than the lab needs: treat it as a lab shortcut, and read the create ACL on `sc_request` (ACL list, Name `sc_request`, Operation `create`, Requires role) to find a narrower role.
7. Test the sign-in on its own at any time with `scripts/test-signin` (modes: basic, oauth, request). It stores nothing; the `request` mode creates one fictional request and prints ServiceNow's own refusal reason.
8. If a customer number cannot be read (store-secret says so), check the ACL on `sys_user.employee_number`. The store-secret check only samples the first 20 users, so it can say "NONE readable" even when the test user is fine; `invoke-test` is the real proof.
5. If a customer number cannot be read (store-secret says so), check the ACL on `sys_user.employee_number` and let the integration user read it.

*4.2 Test callers*

1. Users > New. User ID `test.caller.lab`, first name `Test`, last name `Caller Lab`, **Mobile phone** `+61355500101`, **Employee ID** `48201357`. Save.
   The lab uses Employee ID as a stand-in customer number. The last 4 digits are **1357**.
2. Optional, for the "not your ticket" test: a second user `other.caller.lab`, mobile `+61355500102`, Employee ID `99990000`.

The lab matches a caller on mobile or business phone. A number stored in another format will not match.

*4.3 OAuth application (recommended)*

1. All > System OAuth > Application Registry > New > "Create an OAuth API endpoint for external clients".
2. Name `connect-lab`. Save. Open it and copy the **Client ID** and **Client Secret** straight into the store-secret prompt (do not paste them in chat or a file).
3. Client-credentials needs a system property in recent releases. Search System Properties for `glide.oauth.inbound.client.credential.grant_type.enabled` and set it to true. The property name can differ by release; if there is no such property, use `basic` in store-secret and say so honestly in an interview.
4. The OAuth application acts as a user. If your release asks for one, set it to `svc_connect_lab`.
5. In the first live run (30 Oct 2026) the client-credentials request was refused on the developer instance and was not resolved, so the live proof used `basic`. Say so honestly if asked.

> Never use the admin account for the lab, and never paste any password into a URL, a chat or a file.

## 5. Order of work

1. Install tools and set up ServiceNow (section 4).
2. `check-offline` (no AWS, no ServiceNow touched).
3. `store-secret` (checks the sign-in first, shows what the user can read, then stores it).
4. `plan` (expect **22 to add, 0 to change, 0 to destroy**; 23 if you set `alarm_email`; 25 or 26 with the optional Contact Lens route, section 11b).
5. `terraform apply tfplan` by hand, or let `run-all` do steps 2 to 6 with you typing `yes` and `apply`.
6. `invoke-test` (expect 16 PASS).
7. Optional: test the flow in the Connect console, or a real call.
8. `remove` when finished.

`install-workflows` copies the two GitHub Actions files into `.github/workflows`. GitHub only runs workflows from there.

## 6. Testing

* **Unit tests (157).** Each action, verification, OAuth refresh and the shared token request, idempotency, error paths, the audit field list, and the generated flow (every branch reaches the queue or a goodbye; `callerVerified` is only set after a successful check).
* **invoke-test (16 live checks)** calls the deployed Lambda directly: identify known and unknown; create incident, again, and for an unknown caller; create request with right digits, again, wrong digits and an unknown caller; status of own incident, own request, wrong digits, someone else's ticket and a missing ticket; call-ended note and call-ended with no ticket.
* **Flow test**: Connect > Routing > Flows > the service desk flow > Test.
* **Real call**: needs a claimed number (billed monthly; Australian numbers need identity verification, 1 to 3 business days) and an agent signed in to the CCP and Available.

Find the tickets in ServiceNow: Incident > All and Service Catalog > Requests, short description starting "Phone call".

## 7. Lab notes: what each part is for

|Part|Plain English|
|-|-|
|Contact flow|The phone menu. Generated from `tools/gen-flow.mjs` so a typo cannot break a branch silently.|
|Lambda `servicedesk`|The go-between. Asks ServiceNow, checks the digits, never leaks the secret.|
|Secrets Manager|Where the ServiceNow sign-in lives. Not in git, not in Terraform state.|
|EventBridge rule|Notices the call ended and tells the Lambda to write the work note.|
|Alarms and SNS|Tell you when something breaks or when someone keeps guessing digits.|
|KMS key|Locks the alarm messages. CloudWatch needs a customer-managed key to publish to an encrypted topic.|
|Saved queries|The audit view: pick a contact id and read what happened, in order.|

## 8. The audit trail

In CloudWatch > Logs Insights > Saved queries you will find four queries named `<prefix>/...`:

* **audit trail for one contact** - set the contact id, read every decision in order.
* **verification failures** - who failed, when, why (wrong digits, no reference, unknown number).
* **tickets created by type and day** - incidents against requests.
* **status checks refused** - tickets asked about that did not belong to the caller.

Audit events: `caller_identified`, `caller_unknown`, `incident_created`, `incident_existing`, `request_created`, `request_existing`, `verification_passed`, `verification_failed`, `status_read`, `status_refused`, `call_ended_note`. Fields: `contactId`, `auditEvent`, `ticketType`, `ticketNumber`, `reason`, `callerLast4`. Nothing else can be added: a new field would not compile. (A failed work note is a metric and an alarm, not an audit event.)

## 9. What a real bank would add

This lab shows the idea. It is not a bank-grade system.

* **Rate limiting and lockout per number.** The lab only raises an alarm after repeated failures. A bank blocks the number or forces an agent after N wrong tries.
* **A stronger factor.** Last 4 digits is weak. A bank adds a one-time passcode, an app push or voice biometrics.
* **An immutable audit store.** CloudWatch Logs can be deleted by an administrator. A bank streams to S3 with Object Lock (WORM) via Firehose, with retention set by regulation.
* **CloudTrail and Config**, private connectivity to ServiceNow, secret rotation, WAF or IP allow-lists on the instance, a dead-letter queue for failed work notes, and a tested incident response plan.
* **Call recording consent, PCI scope** (never ask for card numbers over a plain flow) and data residency.

## 10. Cost and cleanup

* Lambda, EventBridge, alarms and logs at lab volume: cents.
* KMS customer key: about 1 USD a month while it exists.
* Secret in Secrets Manager: about 0.40 USD a month.
* Connect: no standing charge without a claimed number. A claimed number and calls are billed.
* ServiceNow PDI: free.

`remove` runs `terraform destroy` for everything this lab created. Your Connect instance and queue are untouched (they are only read). The KMS key sits in "pending deletion" for 7 days (the AWS minimum). The secret is left on purpose. To delete it as well:

PowerShell:

```powershell
aws secretsmanager delete-secret --secret-id lab/servicedesk `
  --recovery-window-in-days 7
```

Git Bash:

```bash
aws secretsmanager delete-secret --secret-id lab/servicedesk \
  --recovery-window-in-days 7
```

Release any claimed phone number separately.

## 11. Limits and what is NOT proven

Be honest about these in an interview.

**Proven live (30 Oct 2026, a personal AWS lab account in Sydney and a personal ServiceNow developer instance)**

* `terraform plan` and `apply` with the real AWS provider: 22 resources created (21 first, then the flow after two fixes).
* Amazon Connect accepted and created the contact flow, after the two rule fixes in section 12b.
* `invoke-test`: all 16 checks (of the 16 it had on 30 Oct 2026; it now has 18, the last two for the Contact Lens route) passed against the live ServiceNow, signed in with Basic auth: caller lookup, verification by the last 4 digits, incident and request creation, status checks (own, wrong digits, someone else's, missing), and the work note after a call.
* The ServiceNow roles that made it work (section 4.1) and the `employee_number` read.
* A real phone call (30 Oct 2026): the flow answered, played the menu, sent the caller-only option to the queue for an unrecognised number, and created an incident (Phone channel) whose number it read back.

**Built and unit-tested, live run pending (see `SESSION-BASH.md` / `SESSION-POWERSHELL.md`)**

* The Contact Lens route: a Contact Lens rule matches, EventBridge sends the event to this Lambda, which notes the call's ticket or opens an incident (section 11b). 12 unit tests against a fake ServiceNow; the event's exact name and shape are unconfirmed until a live call (two AWS pages disagree, so both names are accepted).

**Not proven**

* The recognised-caller path by phone (verification with the last 4 digits). A real phone call (30 Oct 2026) reached the flow, played the menu, created an incident for an unrecognised caller and read the number back; the verified path was tested by script only.
* The call-ended event reaching the Lambda through EventBridge from a real DISCONNECTED event (test 15 calls the Lambda directly).
* OAuth client credentials (refused on the developer instance; not resolved).
* The narrowest ServiceNow role for creating requests (`catalog_admin` is broader than needed).
* PowerShell 5.1 specifically (the scripts ran on the author's Windows PowerShell; the version was not recorded).

**Proven offline:** 157 TypeScript unit tests against a fake ServiceNow (including OAuth), strict type checking, bundle build, generated-flow structure and security checks, Terraform file checks (parse, references, placeholders, formatting), shellcheck on the bash scripts, and PowerShell parse checks.

**Design limits:** last-4 verification is weak; the customer number is a ServiceNow Employee ID stand-in (a bank has a core-banking customer id); one queue, one flow; the PDI hibernates (the Lambda treats the HTML reply as a degraded reply and the caller still reaches an agent).

## 11b. The Contact Lens route (optional, off by default)

A Contact Lens rule (a category such as `Negative-Sentiment`) can publish an EventBridge event when it matches. With `lens_route_enabled = true` in `terraform.tfvars`, three more resources are created (an EventBridge rule, its target and the permission), and the same Lambda handles that event:

1. The rule name must be in `lens_ticket_rules` (default `Negative-Sentiment`, `Escalation`, `Complaint`). Anything else is ignored.
2. The contact id comes from the event's `contactArn`. If the call already has a ticket (made through the menu), the function adds a work note naming the rule.
3. If it has none, only a rule in `lens_open_rules` (default `Negative-Sentiment`) opens an incident. The others wait and retry, because two rules matching one call arrive at the same instant and would each open an incident. Keep `lens_open_rules` to one rule.
4. The ticket carries only the rule name, when it matched and the contact id: no transcript and no caller details (the event has none; fetching them with `DescribeContact` is a design step, not built).
5. AWS documents the event name two ways, so the EventBridge pattern lists both (`conversational analytics ... Rules Matched` and `Contact Lens ... Rules Matched`). The first live run records which one arrives (the `lens event received` audit line).

The Contact Lens rules themselves are created by the helper in `amazon-connect-contact-lens-lab` (`lens categories --apply --eventbridge`). With the route on, the plan expects 25 to add (26 with `alarm_email`).

## 12. Troubleshooting

|Symptom|Likely cause|Fix|
|-|-|-|
|`npm.ps1 cannot be loaded`|PowerShell script policy|Use `npm.cmd`|
|`'node' is not recognised`|Window opened before install|Close and reopen PowerShell|
|store-secret: no answer / HTML|PDI hibernating|Wake it, wait, retry|
|store-secret: refused client ID|Wrong id/secret, or grant not enabled|Re-check section 4.3, or choose `basic`|
|store-secret: customer numbers NONE readable|Employee ID empty or ACL|Fill the field on the test user (4.2); check the ACL (4.1)|
|store-secret: cannot read requests|Missing role|Add `sn_request_write` (4.1)|
|plan: tfvars still has the example id|Not edited|Put your connect_instance_id in `terraform/terraform.tfvars`|
|plan: secret does not exist|Step 3 not done|Run store-secret|
|plan is not 22/0/0|A change made by hand|Read the plan list; do not apply blindly|
|invoke-test 8/9: `no_reference`|Test user has no Employee ID|Fill it in (4.2)|
|invoke-test 6: `error`|Request refused (403)|Add `sn_request_write`|
|Flow says "Sorry, I could not log your issue"|Lambda degraded|CloudWatch log group `/aws/lambda/<function>`, read `reason`|
|Terraform error about `dist/index.js`|Build did not run|The plan script builds first|
|store-secret or test-signin: sign-in rejected (401), but the browser login works|Newer ServiceNow blocks Basic API sign-in until the user has the right role|Add `snc_basic_auth_api_access` (4.1 step 5); untick Password needs reset|
|store-secret: "could not get an answer"|Instance name typed without `dev`|Type the full name, for example `dev123456`|
|plan or init: "Variables not allowed" in terraform.tfvars|Instance id (or any text) without quotes, or the alias used instead of the id|Put the long instance id in double quotes (runbook, Step 5)|
|plan: queue not found|`queue_name` does not exist on that instance|Use a queue that exists, for example `BasicQueue`|
|apply: `InvalidContactFlowException` (400) with no detail|Connect refused the flow and Terraform hides why|Run `scripts/probe-flow`; it prints Connect's problem list (section 12b)|
|invoke-test 6 and 7: `http_403`|The user may not create requests|Section 4.1 steps 5 and 6; confirm with `test-signin` mode `request`|

## 12b. First live run (30 Oct 2026): what went wrong and how it was fixed

|Wall|What we saw|Fix|
|-|-|-|
|Basic sign-in rejected|`store-secret` said rejected although the password worked in the browser; curl showed "User is not authenticated"|Role `snc_basic_auth_api_access` (and `snc_platform_rest_api_access`) on the integration user|
|Generate-only password|Set Password only generated; saving ticked Password needs reset|Copy the generated password, then untick Password needs reset and Update|
|No "Web service access only"|Box missing on a newer release|Not needed; leave Identity type alone|
|Wrong instance name|Typed without `dev`|`dev` plus the digits|
|tfvars|Instance alias and no quotes|Quoted long instance id; an existing queue name|
|Flow refused: Compare blocks|Connect: "Invalid Action error. Error: NoMatchingError" on every Compare block|Compare blocks route only NoMatchingCondition (generator fixed, test added)|
|Flow refused: stored input|Connect: "Error: InputTimeLimitExceeded" on the five digit-capture blocks|Stored-input blocks route only NoMatchingError (generator fixed, test added)|
|Incident timeouts|First run: three incident tests timed out at 3 seconds each|Transient on the free instance; they passed on the next run, so the limits were not changed|
|Request creation 403|"ACL Exception Insert Failed due to security constraints"|Added `catalog_admin` (lab shortcut); narrower role not determined|

The flow problems were found with `scripts/probe-flow`, which sends the same flow to Connect under a throw-away name and prints the problem list that Terraform hides. Connect reports every problem it finds in one answer, so run the probe after each fix until it says the flow is accepted.

## 13. Files

|Path|What it is|
|-|-|
|`lambda/servicedesk/`|TypeScript Lambda, 157 tests, build script|
|`tools/gen-flow.mjs`|Generates the Connect flow template|
|`tools/check-terraform.py`|Offline Terraform file checker|
|`tools/probe-flow.mjs`|Asks Connect why it refused the flow (via `scripts/probe-flow`)|
|`terraform/`|Lambda, role, rule, flow, alarms, KMS, SNS, saved queries|
|`scripts/`|check-offline, store-secret, test-signin, plan, invoke-test, audit-trail, probe-flow, remove, install-workflows, run-all (each as .ps1 and .sh)|
|`ci/workflows/`|node.yml and terraform.yml, installed by `install-workflows`|
|`docs/`|This manual, the two runbooks, and the two one-session runbooks (`SESSION-*.md`)|
