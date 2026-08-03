<#
.SYNOPSIS
    Register the Solar Guard local server (Node) as a scheduled task so it
    starts at logon and restarts itself if it ever dies. Also opens the
    dashboard port on the LAN.

.DESCRIPTION
    This replaces the PowerShell reader entirely. The Node server reads the
    inverter over Modbus itself, so the two cannot run at the same time - the
    SUN2000 accepts only one Modbus client. The old reader task is disabled
    (not deleted) so switching back is one command.

    Needs administrator rights for the task and the firewall rule. The script
    asks for them itself - run it normally and approve the Windows prompt.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.PARAMETER NoFirewall
    Skip the firewall rule. The dashboard then works only on this machine
    (http://localhost:8787), not from phones or the wall display.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-ServerTask.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-ServerTask.ps1 -Remove
#>

[CmdletBinding()]
param(
    [string]$TaskName = "Solar Guard Server",
    [string]$OldTaskName = "Solar Guard Modbus Reader",
    [int]$Port = 8787,
    [string]$LogFile = "$env:USERPROFILE\solar-guard-server.log",
    [switch]$NoFirewall,
    [switch]$Remove,
    [switch]$Elevated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$FirewallRule = "Solar Guard dashboard ($Port)"

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

    # Build the argument list one item at a time. Hand-assembling one long
    # command string re-parses the quoting twice and the variables vanish
    # before the inner shell ever sees them.
    $argv = @(
        "-ExecutionPolicy", "Bypass",
        "-NoProfile",
        "-File", $PSCommandPath,
        "-TaskName", $TaskName,
        "-OldTaskName", $OldTaskName,
        "-Port", $Port,
        "-LogFile", $LogFile,
        "-Elevated"
    )
    if ($NoFirewall) { $argv += "-NoFirewall" }
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

$root = Split-Path -Parent $PSScriptRoot          # ...\solar-guard
$entry = Join-Path $root "server\server.js"
if (-not (Test-Path $entry)) { throw "Not found: $entry" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $node)) { throw "node.exe not found. Install Node.js or pass its path." }

if ($Remove) {
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false } catch { }
    Write-Host "Removed task: $TaskName" -ForegroundColor Green
    try { Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction Stop; Write-Host "Removed firewall rule" } catch { }
    Write-Host ""
    Write-Host "To go back to the PowerShell reader:" -ForegroundColor Yellow
    Write-Host "  Enable-ScheduledTask -TaskName '$OldTaskName'"
    Write-Host "  Start-ScheduledTask  -TaskName '$OldTaskName'"
    Read-Host "`nPress Enter to close"
    return
}

# The inverter accepts ONE Modbus client. Leaving the old reader running would
# make both fight over the single slot and neither would read reliably.
foreach ($t in @($OldTaskName)) {
    try {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
            Disable-ScheduledTask -TaskName $t | Out-Null
            Write-Host "Disabled: $t (not deleted)" -ForegroundColor Yellow
        }
    } catch { }
}

# Stop any copy started by hand, for the same reason.
$me = $PID
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" |
    Where-Object {
        $_.ProcessId -ne $me -and $_.CommandLine -and
        ($_.CommandLine -match 'server\\server\.js' -or $_.CommandLine -match '-File\s+"[^"]*ModbusReader\.ps1"')
    } |
    ForEach-Object {
        Write-Host "Stopping stray process (PID $($_.ProcessId))"
        try { Stop-Process -Id $_.ProcessId -Force } catch { }
    }

# ---- register the task -----------------------------------------------------

# Working directory matters: server.js resolves wrangler.toml and .dev.vars
# relative to its own folder, but the SQLite file lands under the working dir
# if a relative path is ever used. Pin it to the project root.
# Run through server\run-server.cmd rather than assembling the whole command
# here. Doing it inline needs three nested levels of quoting (cmd, paths with
# spaces, redirection) and breaks in ways that are painful to debug from a
# scheduled task. The wrapper also sets the UTF-8 codepage so the Thai text in
# the log stays readable.
$launcher = Join-Path $root "server\run-server.cmd"
if (-not (Test-Path $launcher)) { throw "Not found: $launcher" }

$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $root

# Two triggers on purpose:
#   at logon  - normal start
#   every 5 min forever - a watchdog. With MultipleInstances=IgnoreNew this is
#     a no-op while the server is alive, and restarts it within 5 minutes if it
#     ever died. "Restart on failure" alone was not enough: on 2026-08-03 the
#     server exited with STATUS_CONTROL_C_EXIT when the console window that
#     launched it was closed, Task Scheduler counted that as a clean stop, and
#     nothing brought it back. Nobody would have noticed until the bill arrived.
$tLogon = New-ScheduledTaskTrigger -AtLogOn
$tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @($tLogon, $tRepeat)

# -Hidden matters more than it looks. Without it the task gets a visible
# console in the interactive session, and closing that window sends Ctrl+C
# to the server - which is exactly how it died the first time.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 2) `
    -ExecutionTimeLimit ([timespan]::Zero) `
    -MultipleInstances IgnoreNew `
    -Hidden

# Runs as the current user because .dev.vars sits in that user's project folder.
#
# LogonType S4U is the important part, and -Hidden alone was not enough.
#
# With the default Interactive logon type the task runs inside the desktop
# session and its console app is part of that session's console group. Closing
# any window in that group sends Ctrl+C to it. On 2026-08-03 the server was
# killed that way four times in a row (exit 0xC000013A = STATUS_CONTROL_C_EXIT),
# every time within seconds of finishing startup, and "restart on failure" never
# fired because Windows counts Ctrl+C as a clean exit.
#
# S4U runs the task detached from the interactive desktop, with no console to
# inherit, and needs no stored password. The server does not read DPAPI secrets
# (it uses .dev.vars), so nothing is lost by detaching.
$who = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host ""
Write-Host "Registered: $TaskName" -ForegroundColor Green
Write-Host "  node    : $node"
Write-Host "  script  : $entry"
Write-Host "  workdir : $root"
Write-Host "  log     : $LogFile"

# ---- firewall --------------------------------------------------------------
#
# Private profile only. The factory LAN is Private; leaving Public open would
# expose the dashboard on any coffee-shop wifi this machine ever joins.
if (-not $NoFirewall) {
    try { Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue } catch { }
    New-NetFirewallRule -DisplayName $FirewallRule `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
        -Profile Private,Domain -Description "Solar Guard local dashboard" | Out-Null
    Write-Host "  firewall: TCP $Port allowed on Private/Domain profiles" -ForegroundColor Green
} else {
    Write-Host "  firewall: skipped (dashboard reachable only from this machine)" -ForegroundColor Yellow
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 15

Write-Host ""
Get-ScheduledTask | Where-Object { $_.TaskName -like "Solar Guard*" } |
    Select-Object TaskName, State | Format-Table -AutoSize

# ---- prove it actually answers, do not just claim it started ---------------
#
# 401 counts as alive. The dashboard is token-protected, and this script has no
# business reading the token just to ping it - an HTTP reply of any kind proves
# the process is up and listening, which is the only thing being checked here.
# Treating 401 as failure made the installer report a broken server that was in
# fact working perfectly.
$ok = $false
try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 10
    $ok = $true
    Write-Host "Health check: $($r.Content)" -ForegroundColor Green
} catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401) {
        $ok = $true
        Write-Host "Health check: server is up (401 = dashboard token required, as expected)" -ForegroundColor Green
    } else {
        Write-Host "Health check failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}

if (Test-Path $LogFile) {
    Write-Host ""
    Write-Host "Last lines of the log:" -ForegroundColor Cyan
    # -Encoding utf8 matters: the log is written as UTF-8 but PowerShell 5.1
    # reads with the ANSI codepage by default, which turns Thai into mojibake.
    Get-Content $LogFile -Tail 8 -Encoding utf8
}

Write-Host ""
if ($ok) {
    Write-Host "Done. Open the dashboard at:" -ForegroundColor Green
    Write-Host "  http://localhost:$Port/            (this machine)"
    $ips = Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
    foreach ($ip in $ips) { Write-Host ("  http://{0}:{1}/   ({2})" -f $ip.IPAddress, $Port, $ip.InterfaceAlias) }
} else {
    Write-Host "The task is registered but the server did not answer yet." -ForegroundColor Yellow
    Write-Host "Check the log above, then run:  Start-ScheduledTask -TaskName '$TaskName'"
}

Read-Host "`nPress Enter to close"
