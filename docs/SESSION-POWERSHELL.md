# One session to close the gaps: PowerShell

Lab work, in your own AWS account, on your own lab Amazon Connect instance and your own ServiceNow developer instance. The Meridian Bank instance is never touched.

**What this session closes (each one is proven only when you see its "You should see" line):**

|Gap|Closed by|
|-|-|
|Recognised caller by phone (verified with the last four digits)|Call 1|
|Call-ended event path (EventBridge to a work note)|Call 1|
|Status check by phone, verified|Call 2|
|Bank scenario against the live Lambda|Step 5|
|Contact Lens to ServiceNow (a matched rule opens or notes a ticket)|Call 3|
|Live category (a rule that matches during the call)|Call 3|

One step at a time. Copy each box, paste, press Enter, check the "You should see" line. If anything differs, stop and send me the last lines. Never paste a password, key or phone number into a file or chat.

**Cost.** Part 1 costs cents. Part 2 needs a claimed phone number (billed monthly, release it at the end) and call minutes; real-time analytics adds a per-minute charge, so it is switched on only for Call 3. Total for the session: a few dollars.

## Part 1. Prepare (no phone number, no calls)

### Step 1. Offline checks, three repos (touches no AWS)

```powershell
Set-Location "$HOME\Documents\ITSM\11 GitHub Repos\amazon-connect-servicenow-service-desk"
.\scripts\check-offline.ps1
```

You should see: every line PASS and "All stages that ran passed" (157 unit tests; the Terraform format check is skipped if Terraform is not installed).

```powershell
Set-Location "$HOME\Documents\ITSM\11 GitHub Repos\amazon-connect-contact-lens-lab"
.\scripts\check-offline.ps1
```

You should see: "All stages passed. Nothing was sent to AWS."

### Step 2. ServiceNow: add a test user that has your own phone

Do not change **Test Caller Lab**: the live test table in Step 4 uses its fictional number. Add a second user.

1. Wake your developer instance if it is asleep (developer.servicenow.com, then open it and wait).
2. All > User Administration > Users > **New**.
3. User ID `phone.caller.lab`, first name `Phone`, last name `Caller Lab`.
4. **Mobile phone**: your own mobile in international form with no spaces (for example `+614...`).
5. **Employee ID**: `61002468`. The last four digits, **2468**, are the "PIN" you will key in on the calls.
6. Save.

You should see: the user saved. Your number lives only in your ServiceNow instance. Never put it in a file, repository or chat.

### Step 3. Turn the Contact Lens route on

Open `terraform\terraform.tfvars` and add this line at the bottom (it is gitignored, so it stays on your PC):

```
lens_route_enabled = true
```

You should see: nothing yet. The next step's plan will say 25 to add.

### Step 4. Plan, apply and test (one guided script)

```powershell
Set-Location "$HOME\Documents\ITSM\11 GitHub Repos\amazon-connect-servicenow-service-desk"
.\scripts\run-all.ps1
```

1. Checks pass. At the secret step press **Enter** to keep the existing `lab/servicedesk` secret (type `redo` only if you need to enter it again).
2. The plan VERDICT should say **25 to add, 0 to change, 0 to destroy** (26 if you set `alarm_email`). Type `apply` only if it does.
3. The live test table runs 18 checks.

You should see: all 18 rows PASS. Rows 17 and 18 test the Contact Lens route: they must say PASS, not SKIP (SKIP means the route is still off). Then:

```powershell
.\scripts\audit-trail.ps1
```

You should see: `lens event received` and `lens_ticket_created` lines for the two test events.

### Step 5. The bank story against the live Lambda

```powershell
Set-Location "$HOME\Documents\ITSM\11 GitHub Repos\aws-enterprise-bank-servicenow-lab"
.\scripts\run-scenario.ps1
```

You should see: the five scenes run and every check pass, as it did in `--simulate`. If any check fails, send me the last lines.

### Step 6. Contact Lens rules: add the event, add the live rules

Set the alias of your lab instance once per window, then make the changes. The helper never touches the bank instance.

```powershell
Set-Location "$HOME\Documents\ITSM\11 GitHub Repos\amazon-connect-contact-lens-lab"
$env:LENS_INSTANCE_ALIAS = "your-lab-instance-alias"
.\scripts\lens.ps1 check
```

You should see: the checks run, no STOP line.

Preview, then apply. The first command adds the "send an event" action to the six rules you already have (it changes nothing else). The second creates three live rules.

```powershell
.\scripts\lens.ps1 categories --eventbridge
.\scripts\lens.ps1 categories --apply --eventbridge
.\scripts\lens.ps1 categories --realtime
.\scripts\lens.ps1 categories --realtime --apply
```

You should see: the first and third commands say "dry run" and change nothing; the second says it added the EventBridge action to rules; the fourth creates `Live-Complaint`, `Live-Escalation` and `Live-Negative-Sentiment`. If AWS refuses a live rule, the helper says so: write down the message and tell me, that is a finding.

Check one rule:

```powershell
.\scripts\lens.ps1 rule-export --name Negative-Sentiment
```

You should see: `GENERATE_EVENTBRIDGE_EVENT` in the Actions.

## Part 2. The calls (claim a number first)

### Step 7. Claim a number and point it at the service desk flow

1. Amazon Connect > your lab instance > Channels > **Phone numbers** > **Claim a number** (Australia, DID).
2. Under **Contact flow / IVR** choose `lab-sd-service-desk-flow`. Save.

You should see: the number listed with that flow. (Use the flow name Terraform printed if you changed `name_prefix`.)

### Step 8. Call 1: a recognised caller asks for something, then hangs up

Sign in to the Connect agent CCP (**Available**), then call the number **from your own mobile**.

1. Hear the welcome. Press **2** (ask for something), then **1** (access).
2. Hear "enter the last four digits": key **2468** then **#**.
3. Hear "You are verified. I have logged your request. Your reference number is ...". **Write the seven digits down.**
4. Answer in the CCP, say hello, then hang up and click **Close contact**.

You should see: the verified message (recognised caller, correct digits). Wait one minute, then:

```powershell
Set-Location "$HOME\Documents\ITSM\11 GitHub Repos\amazon-connect-servicenow-service-desk"
.\scripts\audit-trail.ps1
```

You should see: `verification_passed`, `request_created` and, after you hung up, `call_ended_note`. In ServiceNow, open the new request: the work notes say "Amazon Connect: the call has ended. Duration ... Handled by an agent: yes."

### Step 9. Call 2: check the request by phone

Call again from the same mobile.

1. Press **3** (check a ticket), then **2** (a request).
2. Key the seven digits you wrote down, then **#**. Key **2468** then **#**.

You should see: it reads back the request's state and says goodbye (no agent needed). `audit-trail` shows `status_read`.

### Step 10. Switch to the Contact Lens flow for the last call

1. Phone numbers > your number > change the flow to `lens-lab-flow`. Save.
2. Turn on real-time analytics in that flow (guide `LAB-GUIDE.md` in the Contact Lens repo, Part 7b, step 1). Save, then **Publish**.
3. Open a private window and sign in as your second Connect user (set it **Offline**) with Real-time metrics open (Part 7b, steps 2 and 3).

You should see: the flow published and the second window ready.

### Step 11. Call 3: an unhappy customer (the Contact Lens to ServiceNow call)

Agent lines go into the **CCP microphone**, customer lines into the **phone**. Never read the words "Agent" or "Customer" aloud. Call from your mobile and answer in the CCP.

* Customer (phone): "I want to make a complaint. This is unacceptable and I am very unhappy. Your service has been terrible."
* Agent (CCP mic): "I am sorry to hear that. Tell me what happened."
* Customer (phone): "I want to speak to a supervisor. I am so disappointed."
* Agent (CCP mic): "I understand. I will note this down."

While the call is live, in the second window click the **eye** on the agent's row and watch the transcript. Then look at the contact for a `Live-Complaint` category. Hang up and click **Close contact** in the CCP.

You should see: the live transcript. Whether a Live- category appeared during the call is the finding: write down what you saw and when.

### Step 12. After the call: the ServiceNow ticket and the proof

Wait 3 to 5 minutes (post-call analytics finishes after the call). Then:

```powershell
.\scripts\audit-trail.ps1
```

You should see, in this order:

1. `lens event received` lines. The first one records **which event name Amazon Connect really sent** (`conversational analytics ...` or `Contact Lens ...`). Write it down.
2. `lens_ticket_created` for `Negative-Sentiment`.
3. `lens_note` for `Complaint` and `Escalation`.

In ServiceNow: Incident > All: **Contact Lens: Negative-Sentiment call**, with work notes naming the other rules. In Connect: Analytics and optimization > Contact search > open the call: the categories (Complaint, Escalation, Negative-Sentiment and any Live- ones).

Normal and not a fault: if a note-only rule (Complaint, Escalation) arrives before the incident exists, the function waits and Lambda retries about a minute later, so its note can appear a minute late and the Lambda Errors alarm may fire once.

### Step 13. Tell me what you saw

Paste the `audit-trail` output (it holds no secrets) and answer: which event name arrived, which categories showed on the contact, whether a Live- category showed during the call, and whether the incident appeared. I will record exactly that, no more.

## Part 3. Clean up

### Step 14. Stop the extra charge and release the number

1. Edit `lens-lab-flow`: the analytics block back to **Post-contact analytics**. Save and **Publish**.
2. Phone numbers > tick your number > **Release**. Close the private window. Set the second user back to a normal state or leave it Offline.

### Step 15. Remove the AWS resources

```powershell
Set-Location "$HOME\Documents\ITSM\11 GitHub Repos\amazon-connect-servicenow-service-desk"
.\scripts\remove.ps1
```

You should see: Terraform destroys the resources it created (25, or 22 if the Contact Lens route was off). The Contact Lens rules and the queue stay (they cost nothing).

Only when you are completely finished with the service desk lab, delete the stored ServiceNow sign-in (it goes after 7 days; this stops anything using it):

```powershell
aws secretsmanager delete-secret --secret-id lab/servicedesk --recovery-window-in-days 7 --region ap-southeast-2
```

### Step 16. Check the cost

In a day or two, open AWS Billing > Cost Explorer and group by service. You should see only cents for Lambda, EventBridge and Secrets Manager, and the phone number's days.

## If something does not appear

|Symptom|What to check|
|-|-|
|`audit-trail` shows nothing after Call 3|Wait the full five minutes. Run `lens rule-export --name Negative-Sentiment`: the Actions must include `GENERATE_EVENTBRIDGE_EVENT`. Rules apply to new calls only.|
|Step 4 row 17 says SKIP|`lens_route_enabled = true` is missing from `terraform.tfvars`, or the apply did not finish. Run `.\scripts\run-all.ps1` again.|
|The event arrives but nothing is written|`audit-trail` still shows `lens event received`: read the log group for the reason (`rule_not_allowed` means the rule name is not in `lens_ticket_rules`).|
|No `lens event received` line at all|The EventBridge rule did not match the event. In the EventBridge console create a temporary rule with the pattern `{"source":["aws.connect"]}` and a CloudWatch Logs target, make a short call, read the real event name, then delete the temporary rule and tell me the name.|
|The CCP gets no call|Agent must be **Available** and the routing profile must include `lens-lab-queue` (and the service desk queue for Calls 1 and 2).|
|Verification fails on Call 1|The mobile on **Phone Caller Lab** must be your calling number in international form, and the digits must be **2468**.|

## What each result means for the resume

Record only what you saw. "Run live" needs the "You should see" line. If a step fails, the lab keeps its honest label ("built and unit-tested") and the failure goes in the lab's lessons list: that is still a real result.
