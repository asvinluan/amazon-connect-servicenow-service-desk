#Requires -Version 5.1
<#
.SYNOPSIS
  Copy the two GitHub Actions files from ci\workflows into .github\workflows.

.DESCRIPTION
  GitHub only runs workflows found in .github\workflows. They are kept in
  ci\workflows first so they can be reviewed like any other file.

  Safe by design: it shows what it will do, makes a .bak copy of any file it would
  replace, and asks before writing. Nothing is committed or pushed.

.EXAMPLE
  .\scripts\install-workflows.ps1
#>
Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$from = Join-Path $repo 'ci\workflows'
$to   = Join-Path $repo '.github\workflows'

$files = @(Get-ChildItem -Path $from -Filter '*.yml' -File -ErrorAction SilentlyContinue)
if ($files.Count -eq 0) {
    Write-Host "STOPPED: no .yml files found in $from" -ForegroundColor Red
    exit 1
}

Write-Host "Plan (nothing written yet):"
$todo = @()
foreach ($f in $files) {
    $dest = Join-Path $to $f.Name
    if (-not (Test-Path $dest)) {
        Write-Host "  NEW      $($f.Name)"
        $todo += $f
    } elseif ((Get-FileHash $f.FullName).Hash -eq (Get-FileHash $dest).Hash) {
        Write-Host "  SAME     $($f.Name)  (already installed, skipped)"
    } else {
        Write-Host "  REPLACE  $($f.Name)  (old copy saved as $($f.Name).bak)"
        $todo += $f
    }
}
if ($todo.Count -eq 0) { Write-Host "Nothing to do."; exit 0 }

if ((Read-Host "Type yes to write these files") -ne 'yes') { Write-Host "Cancelled. Nothing was changed."; exit 1 }

New-Item -ItemType Directory -Path $to -Force | Out-Null
foreach ($f in $todo) {
    $dest = Join-Path $to $f.Name
    if (Test-Path $dest) { Copy-Item $dest "$dest.bak" -Force }
    Copy-Item $f.FullName $dest -Force
    $ok = (Get-FileHash $f.FullName).Hash -eq (Get-FileHash $dest).Hash
    Write-Host ("  {0} {1}" -f $(if ($ok) { 'installed' } else { 'MISMATCH' }), $f.Name)
    if (-not $ok) { exit 1 }
}
Write-Host ""
Write-Host "Done. Review with:  git status   then commit and push when you are ready."
exit 0
