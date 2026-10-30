# Asks Amazon Connect why it refused the flow. Prints only the problem list.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $env:AWS_REGION) { $env:AWS_REGION = 'ap-southeast-2' }
foreach ($tool in @('node', 'aws')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "STOPPED: '$tool' is not installed or PowerShell cannot see it." -ForegroundColor Red
        exit 1
    }
}
& node (Join-Path $here '..\tools\probe-flow.mjs')
exit $LASTEXITCODE
