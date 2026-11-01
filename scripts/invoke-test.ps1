#Requires -Version 5.1
<#
.SYNOPSIS
  Run 18 checks (17 and 18 need the Contact Lens route and show SKIP while it is off) against the deployed service desk Lambda and print a PASS/FAIL table.

.DESCRIPTION
  Creates a test incident and a test request in YOUR ServiceNow developer instance.
  Run it only after terraform apply. Find them afterwards by searching the
  incident and request lists for short descriptions starting with "Phone call".

.EXAMPLE
  .\scripts\invoke-test.ps1
#>
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0

if (-not $env:AWS_REGION) { $env:AWS_REGION = 'ap-southeast-2' }
$env:AWS_DEFAULT_REGION = $env:AWS_REGION

foreach ($tool in @('node', 'aws')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "STOPPED: '$tool' is not installed or PowerShell cannot see it." -ForegroundColor Red
        exit 1
    }
}
& aws sts get-caller-identity --query Account --output text 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "STOPPED: no working AWS login. Run  aws configure  (or  aws sso login ) and try again." -ForegroundColor Red
    exit 1
}

& node (Join-Path $PSScriptRoot 'invoke-test.mjs')
exit $LASTEXITCODE
