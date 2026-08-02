<#
.SYNOPSIS
    Register the FusionSolar reader as a Windows scheduled task so it starts by
    itself at logon and restarts if it ever dies.

.DESCRIPTION
    Credentials are NOT passed on the command line - the reader picks them up
    from the encrypted store created by Setup-Credentials.ps1. Run that first.

    The task runs as the current user, because DPAPI ties the credential store
    to this account. Running it as SYSTEM or another user would not be able to
    decrypt the store.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-Task.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-Task.ps1 -IntervalSec 20 -Remove
#>

[CmdletBinding()]
param(
    [string]$TaskName = "Solar Guard FusionSolar Reader",
    [int]$IntervalSec = 30,
    [string]$LogFile = "$env:USERPROFILE\solar-guard-reader.log",
    [string]$CsvFile = "$env:USERPROFILE\solar-guard-readings.csv",
    [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task: $TaskName" -ForegroundColor Green
    return
}

$reader    = Join-Path $PSScriptRoot "FusionWebReader.ps1"
$storePath = Join-Path $PSScriptRoot "fusion-cred.xml"

if (-not (Test-Path $reader)) { throw "Not found: $reader" }
if (-not (Test-Path $storePath)) {
    throw "No credential store. Run Setup-Credentials.ps1 first, then re-run this."
}

# Until the Cloudflare worker exists there is nowhere to push to, so record
# locally instead. Re-run this script after Setup-Credentials.ps1 has a worker
# URL stored and it will switch itself over to pushing.
$hasWorker = $false
try {
    $storeObj = Import-Clixml -Path $storePath
    if ($storeObj.WorkerUrl -and $storeObj.IngestToken) { $hasWorker = $true }
} catch { }

$argline = '-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "{0}" -IntervalSec {1} -LogFile "{2}" -CsvFile "{3}"' -f `
           $reader, $IntervalSec, $LogFile, $CsvFile
if (-not $hasWorker) { $argline += " -NoPush" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argline
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# Never time out, and keep restarting - this job is meant to run forever.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Replaced existing task."
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited | Out-Null

Write-Host ""
Write-Host "Registered: $TaskName" -ForegroundColor Green
Write-Host "  reads every $IntervalSec seconds"
if ($hasWorker) {
    Write-Host "  pushing to $($storeObj.WorkerUrl)"
} else {
    Write-Host "  recording locally only - no worker URL stored yet" -ForegroundColor Yellow
    Write-Host "  after deploying to Cloudflare: re-run Setup-Credentials.ps1, then this script"
}
Write-Host "  log: $LogFile"
Write-Host "  csv: $CsvFile"
Write-Host ""
Write-Host "Start it now without waiting for the next logon:"
Write-Host "  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host ""
Write-Host "Watch it work:"
Write-Host "  Get-Content `"$LogFile`" -Tail 20 -Wait"
Write-Host ""
