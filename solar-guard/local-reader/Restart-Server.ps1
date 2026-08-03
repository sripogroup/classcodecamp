<#
.SYNOPSIS
    Restart the Solar Guard local server so it picks up code changes.

.DESCRIPTION
    The server runs as S4U, in a logon session of its own. That is what stops
    a closing console window from killing it, but it also means an ordinary
    shell cannot stop it - so restarting needs administrator rights.

    This script does nothing else: no config changes, no firewall, no tunnel.
    Just stop, start, and confirm it answers.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Restart-Server.ps1
#>

[CmdletBinding()]
param(
    [string]$TaskName = "Solar Guard Server",
    [int]$Port = 8787,
    [switch]$Elevated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    if ($Elevated) { Write-Host "Could not get administrator rights." -ForegroundColor Red; exit 1 }
    Write-Host "Asking Windows for administrator rights (approve the prompt)..." -ForegroundColor Yellow
    $argv = @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $PSCommandPath,
              "-TaskName", $TaskName, "-Port", $Port, "-Elevated")
    try {
        $p = Start-Process powershell.exe -ArgumentList $argv -Verb RunAs -PassThru -Wait
        exit $p.ExitCode
    } catch {
        Write-Host "Elevation refused. Nothing changed." -ForegroundColor Red
        Read-Host "`nPress Enter to close"; exit 1
    }
}

Write-Host ""
Write-Host "Stopping $TaskName ..." -ForegroundColor Cyan
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'server\\server\.js' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } }

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
}

Write-Host "Starting ..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 16

# An HTTP reply of any kind proves it is up. 200 is the login page,
# 401 means a token is required - both mean the process is listening.
$code = 0
try {
    $r = Invoke-WebRequest "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 10
    $code = [int]$r.StatusCode
} catch {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
}

Write-Host ""
if ($code -gt 0) {
    Write-Host "Server is up (HTTP $code)." -ForegroundColor Green
    Write-Host "  http://localhost:$Port/"
} else {
    Write-Host "Server did not answer. Check the log:" -ForegroundColor Red
    Write-Host "  $env:USERPROFILE\solar-guard-server.log"
}

Write-Host ""
Write-Host "Last lines of the log:" -ForegroundColor Cyan
Get-Content "$env:USERPROFILE\solar-guard-server.log" -Tail 10 -Encoding utf8

Read-Host "`nPress Enter to close"
