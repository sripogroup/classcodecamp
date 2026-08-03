<#
.SYNOPSIS
    Publish the Solar Guard dashboard through the existing Cloudflare Tunnel,
    the same way po/bill/hr/stock.sripogroup.co are published.

.DESCRIPTION
    Adds one ingress rule to the tunnel config, creates the DNS record, and
    restarts cloudflared. Safe to run more than once - if the hostname is
    already there it says so and changes nothing.

    The config is backed up first, using the same naming style as the existing
    backups in that folder.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.PARAMETER Hostname
    Public name to publish. Default solar.sripogroup.co

.PARAMETER Port
    Local port the dashboard listens on. Default 8787

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-Tunnel.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-Tunnel.ps1 -Remove
#>

[CmdletBinding()]
param(
    [string]$Hostname = "solar.sripogroup.co",
    [int]$Port = 8787,
    [string]$ConfigFile = "$env:USERPROFILE\.cloudflared\config.yml",
    [string]$Cloudflared = "C:\cloudflared\cloudflared.exe",
    [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Say { param([string]$m, [string]$c = "Gray") Write-Host $m -ForegroundColor $c }

# ---- checks ----------------------------------------------------------------

if (-not (Test-Path $ConfigFile)) { throw "Tunnel config not found: $ConfigFile" }
if (-not (Test-Path $Cloudflared)) {
    $alt = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
    if ($alt) { $Cloudflared = $alt } else { throw "cloudflared.exe not found" }
}

$lines = @(Get-Content $ConfigFile)

$tunnelId = ""
foreach ($l in $lines) {
    if ($l -match '^\s*tunnel:\s*(\S+)') { $tunnelId = $Matches[1]; break }
}
if (-not $tunnelId) { throw "Could not read the tunnel id from $ConfigFile" }

Say ""
Say "Tunnel   : $tunnelId"
Say "Hostname : $Hostname"
Say "Service  : http://localhost:$Port"
Say ""

# Warn early if nothing is listening - the tunnel would publish a dead page.
$listening = $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if (-not $listening) {
    Say "WARNING: nothing is listening on port $Port right now." "Yellow"
    Say "         Start the Solar Guard server first, or the public page will 502." "Yellow"
    Say ""
}

# ---- back up ---------------------------------------------------------------

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "$ConfigFile.bak_solar-$stamp"
Copy-Item $ConfigFile $backup
Say "Backed up to: $backup" "Cyan"

# ---- edit ------------------------------------------------------------------

$already = $false
foreach ($l in $lines) { if ($l -match [regex]::Escape("hostname: $Hostname")) { $already = $true } }

if ($Remove) {
    if (-not $already) { Say "Hostname is not in the config. Nothing to remove." "Yellow"; Read-Host "`nPress Enter to close"; return }
    $out = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match [regex]::Escape("hostname: $Hostname")) { $i++; continue }  # skip it and its service line
        [void]$out.Add($lines[$i])
    }
    Set-Content -Path $ConfigFile -Value $out -Encoding utf8
    Say "Removed $Hostname from the config." "Green"
}
elseif ($already) {
    Say "$Hostname is already in the config - leaving it alone." "Yellow"
}
else {
    # Insert BEFORE the catch-all. cloudflared matches top to bottom, so a rule
    # placed under "http_status:404" would never be reached.
    $out = New-Object System.Collections.ArrayList
    $inserted = $false
    foreach ($l in $lines) {
        if (-not $inserted -and $l -match '^\s*-\s*service:\s*http_status:404') {
            [void]$out.Add("  - hostname: $Hostname")
            [void]$out.Add("    service: http://localhost:$Port")
            $inserted = $true
        }
        [void]$out.Add($l)
    }
    if (-not $inserted) {
        # No catch-all found - append at the end of the ingress list instead.
        [void]$out.Add("  - hostname: $Hostname")
        [void]$out.Add("    service: http://localhost:$Port")
        [void]$out.Add("  - service: http_status:404")
        Say "No catch-all rule found; appended one at the end." "Yellow"
    }
    Set-Content -Path $ConfigFile -Value $out -Encoding utf8
    Say "Added $Hostname -> http://localhost:$Port" "Green"
}

# ---- validate before touching anything live --------------------------------

Say ""
Say "Validating the config..." "Cyan"
$val = & $Cloudflared --config $ConfigFile tunnel ingress validate 2>&1
$val | ForEach-Object { Say "  $_" }
if ($LASTEXITCODE -ne 0) {
    Copy-Item $backup $ConfigFile -Force
    Say ""
    Say "Config is invalid - restored the backup and changed nothing else." "Red"
    Read-Host "`nPress Enter to close"
    exit 1
}

# ---- DNS -------------------------------------------------------------------

if (-not $Remove) {
    Say ""
    Say "Creating the DNS record..." "Cyan"
    # Already-exists is not an error worth stopping for; the record just stays.
    $dns = & $Cloudflared tunnel route dns $tunnelId $Hostname 2>&1
    $dns | ForEach-Object { Say "  $_" }
}

# ---- restart cloudflared ---------------------------------------------------

Say ""
Say "Restarting cloudflared..." "Cyan"
$old = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'tunnel run' })
foreach ($p in $old) { try { Stop-Process -Id $p.ProcessId -Force } catch { } }
Start-Sleep -Seconds 3

Start-Process $Cloudflared -ArgumentList @("--config", $ConfigFile, "tunnel", "run") -WindowStyle Hidden
Start-Sleep -Seconds 10

$now = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'tunnel run' })
if ($now.Count -ge 1) { Say "cloudflared is running (PID $($now[0].ProcessId))" "Green" }
else { Say "cloudflared did not come back up - start it by hand and check its log." "Red" }

# ---- prove it -------------------------------------------------------------

if (-not $Remove) {
    Say ""
    Say "Testing https://$Hostname/ ..." "Cyan"
    Start-Sleep -Seconds 5
    try {
        $r = Invoke-WebRequest -Uri "https://$Hostname/" -UseBasicParsing -TimeoutSec 25
        Say "  HTTP $($r.StatusCode) - the page is reachable" "Green"
    } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 401) {
            # This is the good outcome: the tunnel works AND the token still guards it.
            Say "  HTTP 401 - tunnel works, and the dashboard token is still required" "Green"
        } elseif ($code -eq 502) {
            Say "  HTTP 502 - tunnel works but nothing is answering on port $Port." "Yellow"
            Say "             Start the Solar Guard server, then reload the page." "Yellow"
        } else {
            Say "  Not reachable yet: $($_.Exception.Message)" "Yellow"
            Say "  DNS can take a minute to spread. Try the URL in a browser shortly." "Yellow"
        }
    }
}

Say ""
Say "Done." "Green"
if (-not $Remove) {
    Say "  https://$Hostname/?k=YOUR_DASHBOARD_TOKEN"
    Say ""
    Say "The page is now on the public internet, protected only by that token." "Yellow"
    Say "Consider putting Cloudflare Access in front of it for real sign-in." "Yellow"
}
Read-Host "`nPress Enter to close"
