#Requires -Version 5.1
<#
.SYNOPSIS
  Remove everything this lab created in AWS. Your Connect instance is not touched.

.DESCRIPTION
  Runs terraform destroy. The Connect instance and queue are only READ by this lab
  (data sources), so they are not in Terraform's state and cannot be destroyed.
  Terraform shows the list and asks you to type yes.

  Left behind on purpose:
    - the secret lab/servicedesk (about 0.40 USD a month; see the manual to delete it)
    - the encryption key for the alarm topic stays for 7 days in "pending deletion"
      (AWS minimum), then disappears.

.EXAMPLE
  .\scripts\remove.ps1
#>
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0

$repo      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$terraform = Join-Path $repo 'terraform'
if (-not $env:AWS_REGION) { $env:AWS_REGION = 'ap-southeast-2' }
$env:AWS_DEFAULT_REGION = $env:AWS_REGION

foreach ($tool in @('aws', 'terraform')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "STOPPED: '$tool' is not installed or PowerShell cannot see it." -ForegroundColor Red
        exit 1
    }
}

$who = & aws sts get-caller-identity --output json 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "STOPPED: no working AWS login. Run  aws configure  (or  aws sso login ) and try again." -ForegroundColor Red
    exit 1
}
$id = $who | ConvertFrom-Json
Write-Host "AWS account : $($id.Account)"
Write-Host "Signed in as: $($id.Arn)"
Write-Host "This removes the service desk lab parts. Be sure this is YOUR lab account." -ForegroundColor Yellow
if ((Read-Host "Type yes to continue") -ne 'yes') { Write-Host "Cancelled. Nothing was changed."; exit 1 }

Push-Location $terraform
try {
    & terraform init -input=false
    if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: terraform init failed." -ForegroundColor Red; exit 1 }
    & terraform destroy -input=true
    $code = $LASTEXITCODE
} finally { Pop-Location }

if ($code -eq 0) {
    Write-Host ""
    Write-Host "Done. The secret lab/servicedesk is still there (about 0.40 USD a month)."
    Write-Host "The alarm key shows as pending deletion for 7 days, then goes."
}
exit $code
