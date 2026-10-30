# Tests the ServiceNow sign-in on its own. Read-only. Stores nothing.
# Works in Windows PowerShell 5.1 and PowerShell 7.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = "Stop"

function Read-Hidden([string]$prompt) {
    $s = Read-Host $prompt -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Get-Status($scriptBlock) {
    try {
        $r = & $scriptBlock
        $c = $r.Content
        if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
        return @{ Code = [int]$r.StatusCode; Body = [string]$c }
    }
    catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ Code = 0; Body = $_.Exception.Message } }
        $body = ""
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $body = [string]$_.ErrorDetails.Message }
        else {
            try {
                $sr = New-Object IO.StreamReader($resp.GetResponseStream())
                $body = $sr.ReadToEnd(); $sr.Close()
            } catch { $body = "" }
        }
        return @{ Code = [int]$resp.StatusCode; Body = $body }
    }
}

$inst = (Read-Host "ServiceNow instance name (for example dev123456)").Trim()
$base = if ($env:SN_BASE) { $env:SN_BASE } else { "https://$inst.service-now.com" }
$mode = (Read-Host "Test basic, oauth or request (press Enter for basic)").Trim().ToLower()
if ($mode -eq "") { $mode = "basic" }

if ($mode -eq "basic") {
    $user = (Read-Host "User name").Trim()
    $pw = Read-Hidden "Password (hidden)"
    $raw = [Text.Encoding]::UTF8.GetBytes($user + ":" + $pw)
    $auth = "Basic " + [Convert]::ToBase64String($raw)
    $pw = $null
    $url = "$base/api/now/table/incident?sysparm_limit=1&sysparm_fields=number"
    $res = Get-Status { Invoke-WebRequest -UseBasicParsing -Uri $url -Headers @{ Authorization = $auth; Accept = "application/json" } }
    Write-Host ""
    Write-Host "ServiceNow answered: HTTP $($res.Code)"
    switch ($res.Code) {
        200 { Write-Host "GOOD. This user and password work. Run store-secret and choose basic." }
        401 { Write-Host "BAD SIGN-IN. Wrong user name or password, or the user is inactive, locked out," ; Write-Host "or 'Password needs reset' is ticked. Fix the user record (guide, Part 2)." }
        403 { Write-Host "SIGNED IN, BUT NOT ALLOWED. Give the user the itil role (guide, Part 2)." }
        0   { Write-Host "NO ANSWER. The instance may be asleep or the name is wrong. Open it in a browser, wait, retry." }
        default { Write-Host "Unexpected answer. Send me this number and what you typed (not the password)." }
    }
}
elseif ($mode -eq "request") {
    # Tries to CREATE one fictional request, then prints ServiceNow's own reason if refused.
    $user = (Read-Host "User name").Trim()
    $pw = Read-Hidden "Password (hidden)"
    $raw = [Text.Encoding]::UTF8.GetBytes($user + ":" + $pw)
    $auth = "Basic " + [Convert]::ToBase64String($raw)
    $pw = $null
    $json = '{"short_description":"Phone call lab test request (safe to delete)"}'
    $res = Get-Status { Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/api/now/table/sc_request?sysparm_fields=number" -Headers @{ Authorization = $auth; Accept = "application/json" } -Body $json -ContentType "application/json" }
    Write-Host ""
    Write-Host "ServiceNow answered: HTTP $($res.Code)"
    if ($res.Code -eq 201 -or $res.Code -eq 200) { Write-Host "GOOD. This user can create requests (one fictional test request was made)." }
    else {
        $msg = ""; $det = ""
        if ($res.Body -match '"message"\s*:\s*"([^"]*)"') { $msg = $Matches[1] }
        if ($res.Body -match '"detail"\s*:\s*"([^"]*)"') { $det = $Matches[1] }
        Write-Host "ServiceNow says: $msg"
        Write-Host "Detail         : $det"
    }
}
elseif ($mode -eq "oauth") {
    $cid = (Read-Host "Client ID").Trim()
    $sec = Read-Hidden "Client secret (hidden)"
    $body = "grant_type=client_credentials&client_id=$([uri]::EscapeDataString($cid))&client_secret=$([uri]::EscapeDataString($sec))"
    $sec = $null
    $res = Get-Status { Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/oauth_token.do" -Body $body -ContentType "application/x-www-form-urlencoded" }
    Write-Host ""
    Write-Host "ServiceNow answered: HTTP $($res.Code)"
    if ($res.Code -eq 200 -and $res.Body -match "access_token") { Write-Host "GOOD. The OAuth application and the grant work. Run store-secret and choose oauth." }
    elseif ($res.Code -eq 200) { Write-Host "ServiceNow answered but gave no token. The instance may be asleep. Retry." }
    elseif ($res.Code -eq 400 -or $res.Code -eq 401) { Write-Host "REFUSED. Wrong client ID or secret, the grant property is off, or the application has no user set (guide, Part 3)." }
    elseif ($res.Code -eq 0) { Write-Host "NO ANSWER. The instance may be asleep or the name is wrong." }
    else { Write-Host "Unexpected answer. Send me this number." }
}
else { Write-Host "Type basic, oauth or request." }
