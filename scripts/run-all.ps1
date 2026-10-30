#Requires -Version 5.1
<#
.SYNOPSIS
  One guided run: offline checks, secret, plan, you type "apply", apply, live tests.

.DESCRIPTION
  Every step is a script you can also run on its own. It stops at the first
  problem. The only thing it never does for you is decide: you type yes / apply
  yourself.

.EXAMPLE
  .\scripts\run-all.ps1
#>
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $env:AWS_REGION) { $env:AWS_REGION = 'ap-southeast-2' }
$env:AWS_DEFAULT_REGION = $env:AWS_REGION

function Step([string]$title) { Write-Host ""; Write-Host "================ $title ================" }
function Stop-At([string]$where) {
    Write-Host ""
    Write-Host "STOPPED at: $where" -ForegroundColor Red
    Write-Host "Fix that, then run .\scripts\run-all.ps1 again. Finished steps are safe to repeat."
    exit 1
}
function Run-Script([string]$name) {
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot $name)
    return $LASTEXITCODE
}

Step "1 of 5  Offline checks (no AWS, no ServiceNow)"
if ((Run-Script 'check-offline.ps1') -ne 0) { Stop-At "offline checks" }

Step "2 of 5  ServiceNow sign-in stored in AWS"
& aws secretsmanager describe-secret --secret-id lab/servicedesk --query Name --output text 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "The secret lab/servicedesk already exists."
    $again = Read-Host "Type redo to enter it again, or just press Enter to keep it"
    if ($again -eq 'redo') { if ((Run-Script 'store-secret.ps1') -ne 0) { Stop-At "store-secret" } }
} else {
    if ((Run-Script 'store-secret.ps1') -ne 0) { Stop-At "store-secret" }
}

Step "3 of 5  Plan (changes nothing)"
$planFile = Join-Path $repo 'terraform\tfplan'
Remove-Item $planFile -ErrorAction SilentlyContinue
if ((Run-Script 'plan.ps1') -ne 0) { Stop-At "plan" }
if (-not (Test-Path $planFile)) { Stop-At "plan (no plan file was produced)" }

Step "4 of 5  Apply"
Write-Host "Read the VERDICT above. If it is not what the lab expects, do not apply."
if ((Read-Host "Type apply to create these resources in your lab account") -ne 'apply') {
    Write-Host "Cancelled. Nothing was changed. The plan file is kept."
    exit 1
}
Push-Location (Join-Path $repo 'terraform')
try { & terraform apply tfplan; $applyExit = $LASTEXITCODE } finally { Pop-Location }
if ($applyExit -ne 0) { Stop-At "apply" }

Step "5 of 5  Live tests"
if ((Run-Script 'invoke-test.ps1') -ne 0) { Stop-At "invoke-test (the apply is done; read the table)" }

Write-Host ""
Write-Host "All five steps finished. When you are done for the day: .\scripts\remove.ps1"
exit 0
