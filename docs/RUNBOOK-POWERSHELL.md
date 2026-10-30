# Service desk lab runbook: Windows PowerShell

One step at a time. Copy each grey box, paste it into PowerShell, press Enter, and check the "You should see" line before moving on. If anything differs, stop and send me the last lines you see.

Lab work, in your own AWS account and your own ServiceNow developer instance only. Never an employer or customer account.

## Step 0. Open PowerShell in the repo

Open **Windows PowerShell** (normal, not administrator).

```powershell
cd "$HOME\Documents\ITSM\11 GitHub Repos\amazon-connect-servicenow-service-desk"
```

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

The second line only affects this window and is forgotten when you close it.

You should see: no output, and your prompt now ends in `amazon-connect-servicenow-service-desk>`.

Check the scripts are there:

```powershell
Get-ChildItem scripts | Select-Object Name
```

You should see 16 files, including `run-all`, `store-secret`, `plan`, `invoke-test`, `remove`, `install-workflows` and `check-offline` as `.ps1` files, plus `store-secret.mjs` and `invoke-test.mjs`.

## Step 1. Install the tools (once)

Run these in **PowerShell** on Windows (on Linux or macOS use your package manager instead). Skip any that already print a version in Step 1b.

```powershell
winget install OpenJS.NodeJS.LTS
```

```powershell
winget install Amazon.AWSCLI
```

```powershell
winget install Hashicorp.Terraform
```

```powershell
winget install Git.Git
```

**Close PowerShell and open a new one**, then repeat Step 0.

## Step 1b. Check the tools

```powershell
node --version
npm.cmd --version
aws --version
terraform version
git --version
```

You should see: Node `v22` or higher, npm 10 or higher, aws-cli 2, Terraform 1.6 or higher, git 2 or higher. Always use `npm.cmd` in PowerShell, never `npm`.

## Step 2. Offline check (touches nothing outside this folder)

```powershell
.\scripts\check-offline.ps1
```

You should see a SUMMARY list where every line is `PASS` (the `terraform fmt` line shows `SKIPPED` if Terraform is not installed yet, which is fine) and the words "All stages that ran passed".

If it says `FAILED`, scroll up to the first `FAILED` line and send me that part.

## Step 3. Set up ServiceNow

Do section 4 of `BUILD-MANUAL.pdf` in your browser: the user `svc_connect_lab` (role `itil`, web-service-access-only), the test caller with mobile `+61355500101` and **Employee ID `48201357`**, and the OAuth application (or plan to use `basic`). Come back here when done.

## Step 4. Sign in to AWS

```powershell
aws sts get-caller-identity
```

You should see your own lab account number. If you see an error, run `aws configure` (or `aws sso login`) and try again.

## Step 5. Create your settings file (first time only)

```powershell
Copy-Item terraform\terraform.tfvars.example terraform\terraform.tfvars
notepad terraform\terraform.tfvars
```

Set `connect_instance_id` to your own Connect instance ID (Connect console > your instance > Overview > the last part of the Instance ARN). Change `queue_name` if your queue is not `lab-queue-general`. Optionally set `alarm_email`. Save and close.

`terraform.tfvars` is ignored by git and is never committed.

Two things to get right in that file: the instance ID is the **long code** (not the alias) and it goes in **double quotes**; and `queue_name` must be a queue that already exists on that instance (for example `"BasicQueue"`):

```text
connect_instance_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
queue_name = "BasicQueue"
```

## Step 6. Store the ServiceNow sign-in as a secret

```powershell
.\scripts\store-secret.ps1
```

It shows the AWS account and asks you to type `yes`. Then it asks for:

* the instance name: the part before `.service-now.com`
* the sign-in method: Enter for `oauth`, or type `basic`
* for oauth: the client ID, then the client secret (typing is hidden)
* for basic: the user (Enter accepts `svc_connect_lab`), then the password (hidden)

You should see: "can read incidents: yes", the request and user lines, a count of customer numbers readable, and "created a new secret" (or "updated"). Nothing secret is printed.

If it stops: "no answer" means the instance is hibernating (wake it, wait, retry). "refused the client ID" means a wrong id or secret, or the grant is not enabled (manual, section 4.3): rerun and choose `basic`. "NONE readable" for customer numbers means the Employee ID is empty on the test user.

If `store-secret` says the sign-in was rejected, test it on its own (stores nothing; modes basic, oauth, request):

```powershell
.\scripts\test-signin.ps1
```

HTTP 401 means the user needs the roles and tick-boxes in section 4.1 of the manual (`snc_basic_auth_api_access`, Password needs reset unticked). HTTP 403 means signed in but missing a role. Type the instance name with its `dev` prefix.

## Step 7. Plan (shows what will change, changes nothing)

```powershell
.\scripts\plan.ps1
```

You should see VERDICT: "add 22, change 0, destroy 0 ... This is the plan the lab expects" (23 to add if you set `alarm_email`).

If it says anything about destroy, or a different number, do not apply. Send me the output.

## Step 8. Apply (this creates the AWS resources)

```powershell
cd terraform
terraform apply tfplan
cd ..
```

You should see "Apply complete! Resources: 22 added, 0 changed, 0 destroyed."

If it stops at `aws_connect_contact_flow` with `InvalidContactFlowException` and no detail, ask Connect for the reason, fix, run `plan` again and re-apply (the old plan file is out of date):

```powershell
.\scripts\probe-flow.ps1
```

## Step 9. Test the Lambda

```powershell
.\scripts\invoke-test.ps1
```

You should see a table with 16 lines, all `PASS`. It creates one fictional incident and one fictional request in your ServiceNow instance. Look for them under Incident > All and Service Catalog > Requests, short description starting "Phone call".

## Step 10. Shortcut: all of the above in one guided run

Steps 2, 6, 7, 8 and 9 can be done in one go. It stops at the first problem and waits for you to type `yes` and `apply`:

```powershell
.\scripts\run-all.ps1
```

## Step 11. Optional: test the flow

In the Amazon Connect console open Routing > Flows > the `<name_prefix>-service-desk-flow` (default `lab-sd-service-desk-flow`) > Test. For a real phone call you need a claimed number (billed monthly) and an agent who is Available in the CCP.

## Step 12. Look at the audit trail

CloudWatch > Logs Insights > Saved queries > `lab-sd/audit trail for one contact`. Paste a contact id from the log and run it.

## Step 13. Remove it when you have finished

```powershell
.\scripts\remove.ps1
```

Terraform lists what it will destroy and asks you to type `yes`. Your Connect instance is not touched. The secret stays (about 0.40 USD a month); the manual says how to delete it.

## Step 14. Save your work in git (you run these)

This folder is a new project, so it needs its own repository. Nothing here pushes for you.

First install the two GitHub Actions files (it shows what it will do and asks):

```powershell
.\scripts\install-workflows.ps1
```

Start the repository:

```powershell
git init -b main
git add -A
git status --short
```

`node_modules`, `dist`, `tfplan`, `terraform.tfvars` and any `.bak` file must **not** appear in the list (they are ignored). If one does, stop and send me the list.

Look for secrets in what is staged:

```powershell
git grep --cached -n -E "AKIA[0-9A-Z]{16}|BEGIN (RSA|PRIVATE)|dev[0-9]{6}"
```

You should see: no output at all. Any line printed is a real finding: stop and send it to me.

```powershell
git commit -m "Add Connect service desk lab with ServiceNow"
```

On GitHub create an **empty** repository named `amazon-connect-servicenow-service-desk` (no README, no licence, no .gitignore). Then:

```powershell
$url = "https://github.com/asvinluan/amazon-connect-servicenow-service-desk.git"
git remote add origin $url
git remote -v
git push -u origin main
```

You should see the address **without** any token in it. Git will open a browser sign-in; never paste an access token into the address. Do not publish the instance name (`devNNNNNN`) anywhere in the repo: the scan above looks for it.

## If something goes wrong

* Close PowerShell and start again from Step 0. Every step is safe to repeat.
* Nothing in this runbook deletes your files. `remove` only destroys the AWS resources Terraform created.
