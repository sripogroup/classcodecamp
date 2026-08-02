<#
.SYNOPSIS
    Ask the deployed Worker to send a test alert through every channel that is
    configured, and report what actually went out.

.DESCRIPTION
    This exists as a script rather than a one-liner for two reasons.

    First, the token goes in the x-token header, not in the URL. A token in a
    query string ends up in server logs, browser history and referrer headers,
    which is a real leak even when nothing malicious happens.

    Second, an ad-hoc one-liner that reads a credential file, unwraps a
    SecureString and immediately posts it to a remote URL is, byte for byte,
    what an infostealer does. Windows Defender flags exactly that shape - it
    fired on this machine on 2026-08-02 and started blocking PowerShell from
    launching at all. Keeping credential handling inside a readable script on
    disk avoids teaching anyone to wave away real warnings.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-Alert.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-Alert.ps1 -ShowState
#>

[CmdletBinding()]
param(
    [string]$CredentialFile,
    [string]$WorkerUrl,
    [switch]$ShowState,

    # Dump the worker's full reply. Use when a channel reports "sent" but the
    # message never arrives - the per-recipient detail says which chat id was
    # used and what the provider answered.
    [switch]$Raw,

    # Register the Telegram webhook so the bot can answer /ack /status /mute
    # typed in the group. Without this the bot can only talk, not listen.
    [switch]$SetupWebhook
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 -bor 12288
} catch {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

if (-not $CredentialFile) { $CredentialFile = Join-Path $PSScriptRoot "fusion-cred.xml" }
if (-not (Test-Path $CredentialFile)) { throw "Credential store not found: $CredentialFile" }

$store = Import-Clixml -Path $CredentialFile
if (-not $WorkerUrl) {
    if ($store.PSObject.Properties.Match("WorkerUrl").Count -and $store.WorkerUrl) {
        $WorkerUrl = $store.WorkerUrl
    }
}
if (-not $WorkerUrl) { throw "No worker URL stored. Pass -WorkerUrl." }

function Get-Plain {
    param([System.Security.SecureString]$Secure)
    if (-not $Secure) { return $null }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

if (-not ($store.PSObject.Properties.Match("DashboardToken").Count) -or -not $store.DashboardToken) {
    throw "No dashboard token stored. Re-run Setup-Credentials.ps1."
}
$headers = @{ "x-token" = (Get-Plain $store.DashboardToken) }
$base = $WorkerUrl.TrimEnd("/")

if ($SetupWebhook) {
    Write-Host ""
    Write-Host "Registering the Telegram webhook..." -ForegroundColor Cyan
    $wh = Invoke-RestMethod -Uri "$base/api/setup-webhook" -Headers $headers -TimeoutSec 40
    $wh | ConvertTo-Json -Depth 5 | Write-Host
    Write-Host ""
    Write-Host "Now type /status in the group - the bot should answer." -ForegroundColor Green
    return
}

Write-Host ""
Write-Host "Asking the worker to send a test alert..." -ForegroundColor Cyan
$res = Invoke-RestMethod -Uri "$base/api/test-alert" -Headers $headers -TimeoutSec 40
if ($Raw) { $res | ConvertTo-Json -Depth 6 | Write-Host }

function Show-Channel {
    param([string]$Label, $Result)
    if (-not $Result) { "{0,-10} : no result" -f $Label | Write-Host; return }
    if ($Result.PSObject.Properties.Match("ok").Count -and $Result.ok) {
        Write-Host ("{0,-10} : sent" -f $Label) -ForegroundColor Green
    } elseif ($Result.PSObject.Properties.Match("skipped").Count -and $Result.skipped) {
        Write-Host ("{0,-10} : not configured - {1}" -f $Label, $Result.skipped) -ForegroundColor DarkGray
    } else {
        Write-Host ("{0,-10} : FAILED - {1}" -f $Label, ($Result | ConvertTo-Json -Compress -Depth 4)) -ForegroundColor Red
    }
}

Write-Host ""
Show-Channel "telegram" $res.chat.telegram
Show-Channel "line"     $res.chat.line
Show-Channel "email"    $res.email

if ($ShowState) {
    Write-Host ""
    Write-Host "Current state from the worker:" -ForegroundColor Cyan
    $st = Invoke-RestMethod -Uri "$base/api/state" -Headers $headers -TimeoutSec 30
    "  level        : {0}" -f $st.level | Write-Host
    "  grid import  : {0} kW" -f $st.gridImportKw | Write-Host
    "  pv           : {0} kW" -f $st.pvKw | Write-Host
    "  load         : {0} kW" -f $st.loadKw | Write-Host
    "  month peak   : {0} kW  (limit {1}, headroom {2})" -f $st.month.peakKw, $st.month.limitKw, $st.month.headroomKw | Write-Host
    "  data stale   : {0}" -f $st.stale | Write-Host
}

Write-Host ""
