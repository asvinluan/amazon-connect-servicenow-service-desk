#Requires -Version 5.1
<#
.SYNOPSIS
  Ask for the ServiceNow login, check it works, and store it in AWS Secrets Manager.

.DESCRIPTION
  You choose how to sign in (oauth or basic), then type the instance name and the
  secret values (hidden as you type). They go to the checker through environment
  variables that exist only while it runs. They are never printed, never written to
  a file and never put on a command line.

.EXAMPLE
  .\scripts\store-secret.ps1
#>
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0

$repo   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lambda = Join-Path $repo 'lambda\servicedesk'
$npm    = if ($env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }

if (-not $env:AWS_REGION) { $env:AWS_REGION = 'ap-southeast-2' }
$env:AWS_DEFAULT_REGION = $env:AWS_REGION

foreach ($tool in @('node', 'aws')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "STOPPED: '$tool' is not installed or PowerShell cannot see it." -ForegroundColor Red
        if ($tool -eq 'node') { Write-Host "Run:  winget install OpenJS.NodeJS.LTS   then close and reopen PowerShell." }
        if ($tool -eq 'aws')  { Write-Host "Run:  winget install Amazon.AWSCLI       then close and reopen PowerShell." }
        exit 1
    }
}

# ---- which AWS account? ------------------------------------------------------
$who = & aws sts get-caller-identity --output json 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "STOPPED: no working AWS login. Run  aws configure  (or  aws sso login ) and try again." -ForegroundColor Red
    exit 1
}
$id = $who | ConvertFrom-Json
Write-Host ""
Write-Host "AWS account : $($id.Account)"
Write-Host "Signed in as: $($id.Arn)"
Write-Host "Region      : $($env:AWS_REGION)"
Write-Host ""
Write-Host "This must be YOUR personal lab account. Never an employer or customer account." -ForegroundColor Yellow
$ok = Read-Host "Type yes to continue"
if ($ok -ne 'yes') { Write-Host "Cancelled. Nothing was changed."; exit 1 }

# ---- the checker needs the AWS SDK that npm ci installs ---------------------
$sdk = Join-Path $lambda 'node_modules\@aws-sdk\client-secrets-manager'
if (-not (Test-Path $sdk)) {
    Write-Host "Installing the Lambda's dependencies first (npm ci)..."
    Push-Location $lambda
    try { & $npm ci --no-audit --no-fund } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Write-Host "STOPPED: npm ci failed." -ForegroundColor Red; exit 1 }
}

# ---- ask ---------------------------------------------------------------------
Write-Host ""
$instance = Read-Host "ServiceNow instance name (the part before .service-now.com, for example devNNNNNN)"
$mode     = Read-Host "Sign-in method: oauth (recommended) or basic (press Enter for oauth)"
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = 'oauth' }
$mode = $mode.Trim().ToLower()
if ($mode -ne 'oauth' -and $mode -ne 'basic') {
    Write-Host "STOPPED: type oauth or basic." -ForegroundColor Red
    exit 1
}

function Read-Hidden([string]$prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$user = ''; $pass = ''; $cid = ''; $csec = ''
if ($mode -eq 'basic') {
    $user = Read-Host "Integration user name (press Enter for svc_connect_lab)"
    if ([string]::IsNullOrWhiteSpace($user)) { $user = 'svc_connect_lab' }
    $pass = Read-Hidden "Password for that user (hidden)"
} else {
    $cid  = Read-Host "OAuth client ID (from the ServiceNow application registry)"
    $csec = Read-Hidden "OAuth client secret (hidden)"
}

# ---- check and store ---------------------------------------------------------
$env:SN_INSTANCE      = $instance
$env:SN_AUTH          = $mode
$env:SN_USER          = $user
$env:SN_PASS          = $pass
$env:SN_CLIENT_ID     = $cid
$env:SN_CLIENT_SECRET = $csec
if (-not $env:SECRET_NAME) { $env:SECRET_NAME = 'lab/servicedesk' }
try {
    & node (Join-Path $PSScriptRoot 'store-secret.mjs')
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:SN_PASS, Env:SN_USER, Env:SN_INSTANCE, Env:SN_AUTH, Env:SN_CLIENT_ID, Env:SN_CLIENT_SECRET -ErrorAction SilentlyContinue
    $pass = $null; $csec = $null
}
exit $code
