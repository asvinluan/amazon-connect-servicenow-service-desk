#Requires -Version 5.1
<#
.SYNOPSIS
  Everything that needs NO AWS and NO ServiceNow: install, typecheck, test, bundle.

.DESCRIPTION
  Stages: tools, npm ci, typecheck, unit tests (which include the contact-flow
  wiring checks), bundle, then the optional Terraform checks.
  Safe to run as often as you like. It changes nothing outside the repository
  folder (it creates lambda\servicedesk\node_modules and \dist, both
  ignored by git).

.EXAMPLE
  .\scripts\check-offline.ps1
#>
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0

$repo   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lambda = Join-Path $repo 'lambda\servicedesk'
$isWin  = ($env:OS -eq 'Windows_NT')
# On Windows call npm.cmd, so the "scripts are disabled" PowerShell rule that
# blocks npm.ps1 can never get in the way.
$npm    = if ($isWin) { 'npm.cmd' } else { 'npm' }

$results = New-Object System.Collections.ArrayList

function Add-Result($name, $state) { [void]$results.Add([pscustomobject]@{ Stage = $name; Result = $state }) }

function Invoke-Stage($name, [scriptblock]$body) {
    Write-Host ""
    Write-Host "== $name" -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    try {
        & $body
        if ($global:LASTEXITCODE -ne 0) { throw "exit code $($global:LASTEXITCODE)" }
        Add-Result $name 'PASS'
    } catch {
        Write-Host "FAILED: $_" -ForegroundColor Red
        Add-Result $name 'FAIL'
    }
}

function Find-Python {
    foreach ($candidate in @('python', 'py', 'python3')) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        # The Windows Store "python" stub exists but prints a message instead of running.
        $ver = & $cmd.Source -c "import sys; print(sys.version_info[0])" 2>$null
        if ($LASTEXITCODE -eq 0 -and "$ver".Trim() -eq '3') { return $cmd.Source }
    }
    return $null
}

# ---- 1. tools --------------------------------------------------------------
Write-Host "Repository: $repo"
Invoke-Stage 'Tools: node and npm are installed' {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js is not installed. In PowerShell run:  winget install OpenJS.NodeJS.LTS   then close and reopen PowerShell."
    }
    $v = (& node --version).Trim()
    Write-Host "node $v, npm $((& $npm --version).Trim())"
    $major = [int]($v.TrimStart('v').Split('.')[0])
    if ($major -lt 22) { throw "Node $v is too old. This lab needs Node 22 or newer. Run:  winget upgrade OpenJS.NodeJS.LTS" }
}

# ---- 2 to 5. the TypeScript Lambda -------------------------------------------
Push-Location $lambda
try {
    Invoke-Stage 'npm ci (install exactly what package-lock.json says)' { & $npm ci --no-audit --no-fund }
    Invoke-Stage 'Typecheck (tsc)'                                      { & $npm run typecheck }
    Invoke-Stage 'Unit tests incl. flow wiring (vitest)'                { & $npm test }
    Invoke-Stage 'Bundle (esbuild -> dist\index.js)'                    { & $npm run build }
} finally {
    Pop-Location
}

# ---- 6. the Terraform, checked offline (optional) ----------------------------
# Needs Python 3 and the python-hcl2 package. It proves the files parse and every
# reference points at something real. It cannot prove the AWS provider accepts the
# arguments: only terraform validate (which needs a download) can, and CI runs it.
$py = Find-Python
if (-not $py) {
    Write-Host ""
    Write-Host "== Terraform static check SKIPPED: Python 3 not found. Install it with:  winget install Python.Python.3.12" -ForegroundColor Yellow
    Add-Result 'Terraform static check' 'SKIPPED'
} else {
    & $py -c "import hcl2" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "== Terraform static check SKIPPED: python-hcl2 is missing. Install it with:" -ForegroundColor Yellow
        Write-Host "   $py -m pip install python-hcl2" -ForegroundColor Yellow
        Add-Result 'Terraform static check' 'SKIPPED'
    } else {
        Push-Location $repo
        try {
            Invoke-Stage 'Terraform static check (parse and references)' { & $py tools/check-terraform.py }
        } finally {
            Pop-Location
        }
    }
}

if (Get-Command terraform -ErrorAction SilentlyContinue) {
    Invoke-Stage 'terraform fmt -check' {
        Push-Location (Join-Path $repo 'terraform')
        try { & terraform fmt -check -recursive } finally { Pop-Location }
    }
} else {
    Write-Host ""
    Write-Host "== terraform fmt SKIPPED: terraform is not installed (winget install Hashicorp.Terraform)" -ForegroundColor Yellow
    Add-Result 'terraform fmt -check' 'SKIPPED'
}

# ---- summary ---------------------------------------------------------------
Write-Host ""
Write-Host "================ SUMMARY ================" -ForegroundColor Cyan
foreach ($r in $results) {
    $colour = switch ($r.Result) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'Yellow' } }
    Write-Host ("  {0,-8} {1}" -f $r.Result, $r.Stage) -ForegroundColor $colour
}
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
if ($failed -eq 0) {
    Write-Host "All stages that ran passed. Nothing was sent to AWS or ServiceNow." -ForegroundColor Green
    exit 0
}
Write-Host "$failed stage(s) FAILED. Scroll up to the first FAILED line." -ForegroundColor Red
exit 1
