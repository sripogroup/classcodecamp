<#
.SYNOPSIS
    Register the Modbus TCP reader as a scheduled task so it starts at logon
    and restarts itself if it ever dies.

.DESCRIPTION
    Replaces the older portal-based reader (FusionWebReader.ps1). The portal
    reader is disabled rather than deleted, so switching back is one command.

    Registering a scheduled task needs administrator rights. This script asks
    for them itself - just run it normally and approve the Windows prompt.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-ModbusTask.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-ModbusTask.ps1 -Remove
#>

[CmdletBinding()]
param(
    [string]$TaskName = "Solar Guard Modbus Reader",
    [string]$OldTaskName = "Solar Guard FusionSolar Reader",
    [int]$IntervalSec = 5,
    # 150 s keeps the day under Cloudflare KV's free-plan write quota of 1,000.
    # See the note in ModbusReader.ps1 before lowering this.
    [int]$PushEverySec = 150,
    [string]$LogFile = "$env:USERPROFILE\solar-guard-modbus.log",
    [string]$CsvFile = "$env:USERPROFILE\solar-guard-readings-modbus.csv",
    [switch]$Remove,
    [switch]$Elevated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---- make sure we are running as administrator -----------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    if ($Elevated) {
        Write-Host "Could not obtain administrator rights. Nothing was changed." -ForegroundColor Red
        exit 1
    }
    Write-Host "Asking Windows for administrator rights (approve the prompt)..." -ForegroundColor Yellow

    # Rebuild the argument list one item at a time. Hand-assembling a single
    # long command string is what broke the first attempt at this: quoting
    # gets re-parsed twice and the variables vanish before the inner shell
    # ever sees them.
    $argv = @(
        "-ExecutionPolicy", "Bypass",
        "-NoProfile",
        "-File", $PSCommandPath,
        "-TaskName", $TaskName,
        "-OldTaskName", $OldTaskName,
        "-IntervalSec", $IntervalSec,
        "-PushEverySec", $PushEverySec,
        "-LogFile", $LogFile,
        "-CsvFile", $CsvFile,
        "-Elevated"
    )
    if ($Remove) { $argv += "-Remove" }

    try {
        $p = Start-Process powershell.exe -ArgumentList $argv -Verb RunAs -PassThru -Wait
        exit $p.ExitCode
    } catch {
        Write-Host "Elevation was refused or failed: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# ---- from here on we are elevated ------------------------------------------

$reader = Join-Path $PSScriptRoot "ModbusReader.ps1"
if (-not (Test-Path $reader)) { throw "Not found: $reader" }

if ($Remove) {
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false } catch { }
    Write-Host "Removed task: $TaskName" -ForegroundColor Green
    Write-Host "Re-enable the portal reader with:" -ForegroundColor Yellow
    Write-Host "  Enable-ScheduledTask -TaskName '$OldTaskName'"
    Read-Host "`nPress Enter to close"
    return
}

# Stop any copy started by hand, otherwise two readers push at once and the
# 15-minute averages get built from interleaved values.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*ModbusReader*" } |
    ForEach-Object {
        Write-Host "Stopping stray reader (PID $($_.ProcessId))"
        try { Stop-Process -Id $_.ProcessId -Force } catch { }
    }

$argline = @(
    '-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden'
    ('-File "{0}"' -f $reader)
    ('-IntervalSec {0}' -f $IntervalSec)
    ('-PushEverySec {0}' -f $PushEverySec)
    ('-LogFile "{0}"' -f $LogFile)
    ('-CsvFile "{0}"' -f $CsvFile)
) -join ' '

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argline
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit ([timespan]::Zero) `
    -MultipleInstances IgnoreNew

# The task runs as the current user because the ingest token is stored with
# DPAPI, which only this account on this machine can decrypt.
$who = "$env:USERDOMAIN\$env:USERNAME"

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -User $who -RunLevel Limited -Force | Out-Null

Write-Host ""
Write-Host "Registered: $TaskName" -ForegroundColor Green
Write-Host "  runs as     : $who"
Write-Host "  reads every : $IntervalSec s"
Write-Host "  pushes every: $PushEverySec s"
Write-Host "  log         : $LogFile"

# Disable, do not delete - switching back should be one command.
try {
    if (Get-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $OldTaskName | Out-Null
        Write-Host "Disabled old portal reader: $OldTaskName (not deleted)" -ForegroundColor Yellow
    }
} catch { }

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 12

Write-Host ""
Get-ScheduledTask | Where-Object { $_.TaskName -like "Solar Guard*" } |
    Select-Object TaskName, State | Format-Table -AutoSize

if (Test-Path $LogFile) {
    Write-Host "Last lines of the log:" -ForegroundColor Cyan
    Get-Content $LogFile -Tail 6
} else {
    Write-Host "No log yet - give it a few more seconds, then check $LogFile" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. The reader will now start by itself at every logon." -ForegroundColor Green
Read-Host "Press Enter to close"
