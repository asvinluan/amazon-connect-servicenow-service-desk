#Requires -Version 5.1
<#
.SYNOPSIS
  Build the TypeScript Lambda, then show what Terraform WOULD change. Changes nothing.

.DESCRIPTION
  Runs npm ci and npm run build (Terraform zips the result), then terraform init
  and terraform plan, and tells you whether the plan is the one this lab expects:
  22 to add, 0 to change, 0 to destroy (23 if you set alarm_email). With lens_route_enabled = true: 25 (26). Apply it yourself afterwards with
  terraform apply tfplan, from the terraform folder.

.EXAMPLE
  .\scripts\plan.ps1
#>
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0

$repo      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lambda    = Join-Path $repo 'lambda\servicedesk'
$terraform = Join-Path $repo 'terraform'
$npm       = if ($env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }
$expectedAdd = 22

# The optional Contact Lens route adds three resources (rule, target, permission).
$tfvarsFile = Join-Path $terraform 'terraform.tfvars'
if ((Test-Path $tfvarsFile) -and (Select-String -Path $tfvarsFile -Pattern '^\s*lens_route_enabled\s*=\s*true' -Quiet)) { $expectedAdd = 25 }

if (-not $env:AWS_REGION) { $env:AWS_REGION = 'ap-southeast-2' }
$env:AWS_DEFAULT_REGION = $env:AWS_REGION

function Stop-Here($message) { Write-Host "STOPPED: $message" -ForegroundColor Red; exit 1 }

foreach ($tool in @('node', 'aws', 'terraform')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        $fix = switch ($tool) {
            'node'      { 'winget install OpenJS.NodeJS.LTS' }
            'aws'       { 'winget install Amazon.AWSCLI' }
            'terraform' { 'winget install Hashicorp.Terraform' }
        }
        Stop-Here "'$tool' is not installed or PowerShell cannot see it. Run:  $fix   then close and reopen PowerShell."
    }
}
if (-not (Test-Path (Join-Path $terraform 'terraform.tfvars'))) {
    Stop-Here "terraform\terraform.tfvars is missing. Copy terraform.tfvars.example to terraform.tfvars and set connect_instance_id."
}

# ---- which AWS account? ------------------------------------------------------
$who = & aws sts get-caller-identity --output json 2>$null
if ($LASTEXITCODE -ne 0) { Stop-Here "no working AWS login. Run  aws configure  (or  aws sso login ) and try again." }
$id = $who | ConvertFrom-Json
Write-Host "AWS account : $($id.Account)"
Write-Host "Signed in as: $($id.Arn)"
Write-Host "This must be YOUR personal lab account. Never an employer or customer account." -ForegroundColor Yellow
if ((Read-Host "Type yes to continue") -ne 'yes') { Write-Host "Cancelled. Nothing was changed."; exit 1 }

# ---- the settings file must point at YOUR Connect instance --------------------
$tfvars = Get-Content (Join-Path $terraform 'terraform.tfvars') -Raw
if ($tfvars -match '00000000-0000-0000-0000-000000000000') {
    Stop-Here "terraform\terraform.tfvars still has the example connect_instance_id. Put in your own instance's ID (Connect console > your instance > Overview > last part of the Instance ARN)."
}

# ---- the secret must exist before plan (Terraform reads its address) ---------
& aws secretsmanager describe-secret --secret-id lab/servicedesk --query Name --output text 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Stop-Here "the secret lab/servicedesk does not exist yet. Run .\scripts\store-secret.ps1 first."
}

# ---- build the Lambda --------------------------------------------------------
Write-Host ""
Write-Host "== Building the TypeScript Lambda" -ForegroundColor Cyan
Push-Location $lambda
try {
    & $npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Stop-Here "npm ci failed." }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { Stop-Here "the build failed." }
} finally { Pop-Location }

# ---- plan --------------------------------------------------------------------
Push-Location $terraform
try {
    Write-Host ""
    Write-Host "== terraform init" -ForegroundColor Cyan
    & terraform init -input=false
    if ($LASTEXITCODE -ne 0) { Stop-Here "terraform init failed." }

    Write-Host ""
    Write-Host "== terraform plan (this changes nothing)" -ForegroundColor Cyan
    & terraform plan -input=false -no-color -out=tfplan 2>&1 | Tee-Object -Variable planOut | Out-Host
    $planExit = $LASTEXITCODE
} finally { Pop-Location }

if ($planExit -ne 0) { Stop-Here "terraform plan failed. Read the first Error line above." }

$text = ($planOut | Out-String)
Write-Host ""
Write-Host "================ VERDICT ================" -ForegroundColor Cyan
if ($text -match 'Plan: (\d+) to add, (\d+) to change, (\d+) to destroy') {
    $add = [int]$Matches[1]; $chg = [int]$Matches[2]; $del = [int]$Matches[3]
    Write-Host "Terraform will: add $add, change $chg, destroy $del"
    if ($del -gt 0) {
        Write-Host "STOP. Something would be DESTROYED. Do not apply. Send me the plan output." -ForegroundColor Red
    } elseif (($add -eq $expectedAdd -or $add -eq ($expectedAdd + 1)) -and $chg -eq 0) {
        Write-Host "This is the plan the lab expects ($add to add, 0 to change, 0 to destroy)." -ForegroundColor Green
        Write-Host "To apply it:   cd terraform ; terraform apply tfplan"
    } else {
        Write-Host "Not the expected $expectedAdd (or $($expectedAdd + 1) with alarm_email) to add and 0 to change. Read the list above before applying." -ForegroundColor Yellow
        Write-Host "(A difference usually means something was changed by hand since the last apply.)"
    }
} elseif ($text -match 'No changes') {
    Write-Host "No changes: the ServiceNow parts are already applied." -ForegroundColor Green
} else {
    Write-Host "Could not read the plan summary. Read the output above." -ForegroundColor Yellow
}
exit 0
