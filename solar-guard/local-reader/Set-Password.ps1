<#
.SYNOPSIS
    Set the dashboard login password, then restart the server so it takes effect.

.DESCRIPTION
    Replaces the 32-character token in the URL with a normal password and a
    normal login page, the same as the other apps in the company.

    The token still exists and still works, but only for machines: scripts and
    devices send it as the x-token header. People never see it again.

    The password is typed here, not passed on the command line, so it does not
    end up in the PowerShell history file. It is written to .dev.vars, which is
    already excluded from git.

    Needs administrator rights only to restart the scheduled task. The script
    asks for them itself.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-Password.ps1
#>

[CmdletBinding()]
param(
    [string]$TaskName = "Solar Guard Server",
    [int]$Port = 8787,
    [switch]$Elevated,
    [string]$PendingPassword
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$devVars = Join-Path $root ".dev.vars"
if (-not (Test-Path $devVars)) { throw "Not found: $devVars" }

# ---- ask for the password (only in the first, non-elevated pass) ------------

if (-not $Elevated) {
    Write-Host ""
    Write-Host "Set the dashboard login password" -ForegroundColor Cyan
    Write-Host "  - pick something you can type on a phone"
    Write-Host "  - at least 6 characters"
    Write-Host "  - everyone who opens the dashboard will use this same password"
    Write-Host ""

    $p1 = Read-Host "New password" -AsSecureString
    $p2 = Read-Host "Type it again" -AsSecureString
    $s1 = [System.Net.NetworkCredential]::new('', $p1).Password
    $s2 = [System.Net.NetworkCredential]::new('', $p2).Password

    if ($s1 -ne $s2) { Write-Host "They do not match. Nothing was changed." -ForegroundColor Red; Read-Host "`nPress Enter to close"; exit 1 }
    if ($s1.Length -lt 6) { Write-Host "Too short. Nothing was changed." -ForegroundColor Red; Read-Host "`nPress Enter to close"; exit 1 }

    # Write it now, while running as the normal user who owns the file.
    $lines = @(Get-Content $devVars | Where-Object { $_ -notmatch '^\s*DASHBOARD_PASSWORD\s*=' })
    $lines += "DASHBOARD_PASSWORD=$s1"
    Set-Content -Path $devVars -Value $lines -Encoding utf8
    Write-Host ""
    Write-Host "Password saved to .dev.vars" -ForegroundColor Green

    # Re-launch elevated purely to restart the task. The password is NOT passed
    # along - the elevated pass only restarts the service.
    $isAdmin = ([Security.Principal.WindowsPrincipal] `
                [Security.Principal.WindowsIdentity]::GetCurrent()
               ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if (-not $isAdmin) {
        Write-Host "Asking Windows for administrator rights to restart the server..." -ForegroundColor Yellow
        $argv = @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $PSCommandPath,
                  "-TaskName", $TaskName, "-Port", $Port, "-Elevated")
        try {
            $p = Start-Process powershell.exe -ArgumentList $argv -Verb RunAs -PassThru -Wait
            exit $p.ExitCode
        } catch {
            Write-Host "Elevation refused. The password is saved, but the server still runs the old one." -ForegroundColor Red
            Write-Host "Restart it later with:  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Yellow
            Read-Host "`nPress Enter to close"
            exit 1
        }
    }
}

# ---- elevated: restart the task -------------------------------------------

Write-Host ""
Write-Host "Restarting $TaskName ..." -ForegroundColor Cyan

# The task runs as S4U, in a different logon session, so Stop-Process from a
# normal shell cannot touch it - that is exactly why it survives closing
# windows now. Stopping it through the scheduler is the supported way.
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 14

$up = $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($up) {
    Write-Host "Server is back up." -ForegroundColor Green
    Write-Host ""
    Write-Host "Open the dashboard - it will now ask for the password:" -ForegroundColor Cyan
    Write-Host ("  http://localhost:{0}/" -f $Port)
    $ips = Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
    foreach ($ip in $ips) { Write-Host ("  http://{0}:{1}/   ({2})" -f $ip.IPAddress, $Port, $ip.InterfaceAlias) }
    Write-Host ""
    Write-Host "No more ?k=... in the address bar." -ForegroundColor Green
} else {
    Write-Host "Server did not come back. Check C:\Users\USER\solar-guard-server.log" -ForegroundColor Red
}

Read-Host "`nPress Enter to close"
