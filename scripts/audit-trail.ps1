#Requires -Version 5.1
<#
.SYNOPSIS
  Show what the deployed Lambda decided (read-only). Run it after a test call.

.EXAMPLE
  .\scripts\audit-trail.ps1
  .\scripts\audit-trail.ps1 -Minutes 120
  .\scripts\audit-trail.ps1 -Contact <contact id>
#>
param(
    [int]$Minutes = 30,
    [string]$Contact = ''
)
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

$nodeArgs = @((Join-Path $PSScriptRoot 'audit-trail.mjs'), '--minutes', "$Minutes")
if ($Contact) { $nodeArgs += @('--contact', $Contact) }
& node @nodeArgs
exit $LASTEXITCODE
