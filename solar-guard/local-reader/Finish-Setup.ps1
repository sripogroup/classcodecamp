<#
.SYNOPSIS
    Finish the Solar Guard setup in one go: restart the server with the latest
    code, clean up duplicate tunnel connectors, set a login password, and
    verify every route end to end.

.DESCRIPTION
    Written to replace the pile of separate steps. Run this one file and it
    reports what actually works at the end, rather than claiming success.

    What it fixes:

    1. Duplicate cloudflared processes.
       Two connectors were registered against the same tunnel, one of them
       still holding an older config without solar.sripogroup.co. Cloudflare
       spreads requests across connectors, so the site answered correctly on
       one and returned 404 on the other, seemingly at random.

    2. The server running stale code.
       It runs as S4U in another logon session, so an ordinary shell cannot
       restart it. That is deliberate - it is why closing a window no longer
       kills it - but it does mean code changes need this script.

    3. The 32 character token in the URL.
       Replaced by a normal login page. The token still works for scripts and
       devices through the x-token header; people never see it again.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Finish-Setup.ps1
#>

[CmdletBinding()]
param(
    [string]$TaskName   = "Solar Guard Server",
    [int]$Port          = 8787,
    [string]$Hostname   = "solar.sripogroup.co",
    [string]$Cloudflared = "C:\cloudflared\cloudflared.exe",
    [string]$TunnelConfig = "$env:USERPROFILE\.cloudflared\config.yml",
    [switch]$SkipPassword,
    [switch]$Elevated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$devVars = Join-Path $root ".dev.vars"

function Say { param([string]$m, [string]$c = "Gray") Write-Host $m -ForegroundColor $c }
function Head { param([string]$m) Write-Host ""; Write-Host $m -ForegroundColor Cyan }

# ---- password first, as the normal user who owns .dev.vars -----------------

if (-not $Elevated -and -not $SkipPassword) {
    $hasPassword = $false
    if (Test-Path $devVars) {
        foreach ($l in Get-Content $devVars) { if ($l -match '^\s*DASHBOARD_PASSWORD\s*=\s*\S') { $hasPassword = $true } }
    }

    Head "1. Dashboard password"
    if ($hasPassword) {
        Say "  A password is already set. Leaving it alone." "Green"
        Say "  (To change it later: local-reader\Set-Password.ps1)"
    } else {
        Say "  Pick something you can type on a phone, at least 6 characters."
        Say "  Everyone who opens the dashboard uses this same password."
        Say "  Press Enter on an empty line to skip and keep using the long token."
        Write-Host ""
        $p1 = Read-Host "  New password" -AsSecureString
        $s1 = [System.Net.NetworkCredential]::new('', $p1).Password
        if (-not $s1) {
            Say "  Skipped." "Yellow"
        } elseif ($s1.Length -lt 6) {
            Say "  Too short - skipped." "Yellow"
        } else {
            $p2 = Read-Host "  Type it again" -AsSecureString
            $s2 = [System.Net.NetworkCredential]::new('', $p2).Password
            if ($s1 -ne $s2) {
                Say "  They do not match - skipped." "Yellow"
            } else {
                $lines = @(Get-Content $devVars | Where-Object { $_ -notmatch '^\s*DASHBOARD_PASSWORD\s*=' })
                $lines += "DASHBOARD_PASSWORD=$s1"
                Set-Content -Path $devVars -Value $lines -Encoding utf8
                Say "  Saved." "Green"
            }
        }
    }
}

# ---- elevate for everything else -------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host ""
    Say "Asking Windows for administrator rights (approve the prompt)..." "Yellow"
    $argv = @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $PSCommandPath,
              "-TaskName", $TaskName, "-Port", $Port, "-Hostname", $Hostname,
              "-Cloudflared", $Cloudflared, "-TunnelConfig", $TunnelConfig,
              "-SkipPassword", "-Elevated")
    try {
        $p = Start-Process powershell.exe -ArgumentList $argv -Verb RunAs -PassThru -Wait
        exit $p.ExitCode
    } catch {
        Say "Elevation refused. Nothing further was changed." "Red"
        Read-Host "`nPress Enter to close"
        exit 1
    }
}

# ---- 2. restart the Solar Guard server -------------------------------------

Head "2. Restarting the Solar Guard server"

try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'server\\server\.js' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 15
Say ("  server listening: {0}" -f ($null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)))

# ---- 3. one cloudflared, not several ---------------------------------------

Head "3. Cleaning up cloudflared connectors"

$procs = @(Get-Process cloudflared -ErrorAction SilentlyContinue)
Say ("  found {0} running" -f $procs.Count)
foreach ($p in $procs) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Say "  stopped PID $($p.Id)" }
    catch { Say "  could NOT stop PID $($p.Id): $($_.Exception.Message)" "Red" }
}
Start-Sleep -Seconds 5

if (-not (Test-Path $Cloudflared)) {
    $alt = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
    if ($alt) { $Cloudflared = $alt }
}
Start-Process $Cloudflared -ArgumentList @("--config", $TunnelConfig, "tunnel", "run") -WindowStyle Hidden
Start-Sleep -Seconds 12

$after = @(Get-Process cloudflared -ErrorAction SilentlyContinue)
Say ("  now running: {0} (should be 1)" -f $after.Count) $(if ($after.Count -eq 1) { "Green" } else { "Yellow" })

# ---- 4. verify, do not assume ----------------------------------------------

Head "4. Checking every route"

function Probe {
    param([string]$Label, [string]$Url, [int[]]$Good = @(200))
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 25
        $code = [int]$r.StatusCode
    } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    }
    $ok = $Good -contains $code
    Say ("  {0,-34} HTTP {1}" -f $Label, $(if ($code) { $code } else { "no answer" })) $(if ($ok) { "Green" } else { "Red" })
    return $ok
}

$results = @()
$results += Probe "local dashboard"            ("http://localhost:{0}/" -f $Port)      @(200)
$results += Probe "local API (needs login)"    ("http://localhost:{0}/api/state" -f $Port) @(401, 200)
$results += Probe ("public " + $Hostname)      ("https://{0}/" -f $Hostname)           @(200)
$results += Probe "hr.sripogroup.co (untouched)"   "https://hr.sripogroup.co/"         @(200, 302, 401)
$results += Probe "stock.sripogroup.co (untouched)" "https://stock.sripogroup.co/"     @(200, 302, 401)

# ---- 5. what to do next ----------------------------------------------------

Head "5. Where to open it"
Say ("  https://{0}/" -f $Hostname) "White"
Say "      from anywhere, no VPN needed"
Say ("  http://localhost:{0}/" -f $Port) "White"
$ips = Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
foreach ($ip in $ips) { Say ("  http://{0}:{1}/   ({2})" -f $ip.IPAddress, $Port, $ip.InterfaceAlias) "White" }

Write-Host ""
if ($results -contains $false) {
    Say "Some checks failed - see the red lines above." "Yellow"
    Say "Server log: $env:USERPROFILE\solar-guard-server.log"
} else {
    Say "All checks passed. Open the address above and log in with your password." "Green"
}

Read-Host "`nPress Enter to close"
