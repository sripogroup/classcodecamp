<#
.SYNOPSIS
    Hand Solar Guard over to the shared Sripo watchdog and remove the
    one-off scheduled task.

.DESCRIPTION
    Every other app on this machine is kept alive the same way:

      Startup\sripo-app-<port>.vbs   starts it at logon
      Sripo Server Watchdog          checks every minute, restarts if the
                                     port stops listening

    Solar Guard was set up with its own scheduled task instead, which is a
    second pattern doing the same job - one more thing to remember, and two
    things racing to start the same port. This script removes that task so
    the house watchdog is the only owner.

    Already done before running this (no admin needed for either):
      - port 8787 added to C:\SripoServer\server-watchdog.ps1
      - Startup\sripo-app-8787.vbs created

    Administrator rights are needed only to delete the scheduled task.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Use-HouseWatchdog.ps1
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
    $argv = @("-ExecutionPolicy","Bypass","-NoProfile","-File",$PSCommandPath,
              "-TaskName",$TaskName,"-Port",$Port,"-Elevated")
    try {
        $p = Start-Process powershell.exe -ArgumentList $argv -Verb RunAs -PassThru -Wait
        exit $p.ExitCode
    } catch {
        Write-Host "Elevation refused. Nothing changed." -ForegroundColor Red
        Read-Host "`nPress Enter to close"; exit 1
    }
}

Write-Host ""
Write-Host "Checking the shared watchdog knows about port $Port ..." -ForegroundColor Cyan
$wd = "C:\SripoServer\server-watchdog.ps1"
$known = (Select-String -Path $wd -Pattern ("port={0};" -f $Port) -Quiet)
if ($known) { Write-Host "  yes" -ForegroundColor Green }
else {
    Write-Host "  NO - port $Port is not in $wd" -ForegroundColor Red
    Write-Host "  Stopping here so the server is not left with nothing watching it." -ForegroundColor Red
    Read-Host "`nPress Enter to close"; exit 1
}

$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) ("sripo-app-{0}.vbs" -f $Port)
Write-Host "Checking the Startup shortcut ..." -ForegroundColor Cyan
if (Test-Path $vbs) { Write-Host "  yes: $vbs" -ForegroundColor Green }
else {
    Write-Host "  NO - $vbs is missing. Stopping." -ForegroundColor Red
    Read-Host "`nPress Enter to close"; exit 1
}

# Only now is it safe to drop the task: something else is already responsible.
Write-Host ""
Write-Host "Removing the one-off task '$TaskName' ..." -ForegroundColor Cyan
try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  removed" -ForegroundColor Green
} catch {
    Write-Host "  could not remove: $($_.Exception.Message)" -ForegroundColor Yellow
}

# The watchdog runs once a minute; give it a chance to pick the server up.
Write-Host ""
Write-Host "Waiting for the watchdog to start the server (up to 90s) ..." -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds(90)
$up = $false
while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
    Start-Sleep -Seconds 5
}

Write-Host ""
if ($up) {
    Write-Host "Server is listening on $Port - the shared watchdog owns it now." -ForegroundColor Green
} else {
    Write-Host "Server did not come up within 90s." -ForegroundColor Red
    Write-Host "Watchdog log:  $env:USERPROFILE\server-watchdog.log"
    Write-Host "Server log:    $env:USERPROFILE\solar-guard-server.log"
}

Write-Host ""
Write-Host "Remaining Solar Guard tasks:" -ForegroundColor Cyan
Get-ScheduledTask | Where-Object { $_.TaskName -like "Solar Guard*" } |
    Select-Object TaskName, State | Format-Table -AutoSize

Write-Host "Last watchdog log lines:" -ForegroundColor Cyan
Get-Content "$env:USERPROFILE\server-watchdog.log" -Tail 6 -Encoding utf8 -ErrorAction SilentlyContinue

Read-Host "`nPress Enter to close"
