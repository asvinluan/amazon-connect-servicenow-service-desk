# Amazon Connect service desk with ServiceNow

**Lab work, labelled as a design.** Built in my own AWS account and a free ServiceNow Personal Developer Instance. No employer or client system, no real customer data.

A caller phones Amazon Connect. A quiet lookup checks whether the number belongs to a known person. The caller can **report a problem** (ServiceNow incident), **ask for something** (ServiceNow request) or **check a ticket**. Anything private is handled only after the caller proves they know the last four digits of their customer number. ServiceNow is reached with OAuth 2.0 client credentials by design (the live lab run used Basic auth, see below), and every decision leaves an audit record.

This is the "designed like a real service desk" version of the ServiceNow incident lab in [`amazon-connect-lab`](https://github.com/asvinluan/amazon-connect-lab) (which stays as the simple first build). A bank-themed walk-through of the same design is in [`aws-enterprise-bank-servicenow-lab`](https://github.com/asvinluan/aws-enterprise-bank-servicenow-lab).

## What is in it

| Area | What |
|-|-|
| Phone menu | Report a problem, ask for something, check a ticket, or an agent. Generated from `tools/gen-flow.mjs`, so every branch is checked by tests. |
| Lambda | TypeScript, Node 22, arm64: `identify`, `create_incident`, `create_request`, `status`, a call-ended work note, and (optional) a Contact Lens route: a matched Contact Lens rule notes the call's ticket or opens an incident. |
| Caller verification | The number suggests who is calling; the last 4 digits of the customer number prove it. The name is never spoken before proof. Not-yours and not-found sound the same. |
| Sign-in | OAuth 2.0 client credentials (token refresh on 401, one shared token request), tested against a fake ServiceNow. Basic auth as a stated fallback: the live run on a developer instance used Basic auth. |
| Audit | One structured line per decision with a closed field list, and four saved CloudWatch Logs Insights queries. |
| Operations | Five alarms (errors, slow, no ticket logged, work note failed, verification failures), encrypted SNS topic with its own KMS key. |
| Scripts | `check-offline`, `store-secret`, `plan`, `invoke-test`, `audit-trail`, `remove`, `install-workflows`, `run-all`, each as PowerShell and bash. |

## Start here

Read `docs/BUILD-MANUAL.md` (a PDF copy is in your Lab Guides folder), then follow **one** runbook:

* `docs/RUNBOOK-POWERSHELL.md` (Windows PowerShell)
* `docs/RUNBOOK-BASH.md` (Git Bash, WSL, Linux, macOS)

Then, to prove the phone and Contact Lens parts in one sitting: `docs/SESSION-POWERSHELL.md` or `docs/SESSION-BASH.md`.

Quick check that needs no AWS and no ServiceNow:

```bash
./scripts/check-offline.sh
```

```powershell
.\scripts\check-offline.ps1
```

## What is proven and what is not

Proven offline: 157 unit tests against a fake ServiceNow (including OAuth), strict type checking, the bundle build, generated-flow structure and security checks, Terraform file checks, shellcheck, PowerShell parse checks.

Proven live (30 Oct 2026, own lab AWS account and own ServiceNow developer instance): Terraform plan and apply with the real provider (22 resources), Amazon Connect accepting the generated flow, and all 16 invoke-test checks passing (caller lookup, verification, incident and request creation, status, work note) using Basic auth. See section 12b of the build manual for what went wrong first and how it was fixed.

**Built and unit-tested, live run pending (`docs/SESSION-*.md`):** the recognised-caller path by phone (a real call has created an incident for an unrecognised caller), DISCONNECTED events reaching the rule through EventBridge, and the Contact Lens route (a matched Contact Lens rule opens or notes a ticket; off by default, `lens_route_enabled = true`).

**Not proven:** OAuth on a developer instance (refused on the free instance), the narrowest ServiceNow role for creating requests (the lab used a broad one), PowerShell 5.1 at run time. The manual lists these and what a real bank would add (lockout, a stronger factor, an immutable audit store).

## Safety rules

* Use only your own lab AWS account and your own developer instance. Never an employer or customer system.
* No secrets in the repo, Terraform state or chat. The sign-in lives in Secrets Manager (`lab/servicedesk`), entered through a hidden prompt.
* The ServiceNow instance name stays out of the repo.

## Next lab: Contact Lens

`amazon-connect-contact-lens-lab` covers conversational analytics: transcripts,
sentiment, categories and ideas for sending them to ServiceNow.

## Licence

MIT. See `LICENSE`.
