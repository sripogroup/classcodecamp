<#
.SYNOPSIS
    Print the ready-to-use dashboard URLs, with the token already filled in.

.DESCRIPTION
    The dashboard is protected by DASHBOARD_TOKEN - a 32 character random
    string created when the system was first set up. It is not something to
    invent or remember; it already exists on this machine, in two places:

      1. solar-guard\.dev.vars           (line DASHBOARD_TOKEN=...)
      2. local-reader\fusion-cred.xml    (encrypted, this Windows account only)

    This script reads it and prints the complete URLs, so there is nothing to
    assemble by hand. Copy one, paste it in the browser once, and the server
    stores a cookie - after that the plain address works on its own.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Show-DashboardUrl.ps1
#>

[CmdletBinding()]
param(
    [int]$Port = 8787
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$token = $null
$source = ""

# 1) .dev.vars - plain text, this is what the local server itself reads
$devVars = Join-Path $root ".dev.vars"
if (Test-Path $devVars) {
    foreach ($line in Get-Content $devVars) {
        if ($line -match '^\s*DASHBOARD_TOKEN\s*=\s*(.+?)\s*$') { $token = $Matches[1]; $source = ".dev.vars" }
    }
}

# 2) fall back to the encrypted store
if (-not $token) {
    $store = Join-Path $PSScriptRoot "fusion-cred.xml"
    if (Test-Path $store) {
        try {
            $s = Import-Clixml $store
            $t = $s.DashboardToken
            if ($t -is [System.Security.SecureString]) {
                $t = [System.Net.NetworkCredential]::new('', $t).Password
            }
            if ($t) { $token = $t; $source = "fusion-cred.xml" }
        } catch { }
    }
}

Write-Host ""
if (-not $token) {
    Write-Host "Could not find DASHBOARD_TOKEN." -ForegroundColor Red
    Write-Host "Looked in:" -ForegroundColor Yellow
    Write-Host "  $devVars"
    Write-Host "  $(Join-Path $PSScriptRoot 'fusion-cred.xml')"
    Read-Host "`nPress Enter to close"
    exit 1
}

Write-Host ("Token found in {0}  ({1} characters)" -f $source, $token.Length) -ForegroundColor Green
Write-Host ""
Write-Host "Copy ONE of these into the browser. You only need to do this once -" -ForegroundColor Cyan
Write-Host "the server then remembers you with a cookie for a year." -ForegroundColor Cyan
Write-Host ""

$running = $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if (-not $running) {
    Write-Host "WARNING: nothing is listening on port $Port - start the server first." -ForegroundColor Yellow
    Write-Host ""
}

Write-Host ("  http://localhost:{0}/?k={1}" -f $Port, $token) -ForegroundColor White
Write-Host "      ^ from this computer" -ForegroundColor DarkGray
Write-Host ""

$ips = Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
       Sort-Object InterfaceAlias
foreach ($ip in $ips) {
    Write-Host ("  http://{0}:{1}/?k={2}" -f $ip.IPAddress, $Port, $token) -ForegroundColor White
    Write-Host ("      ^ from other devices via {0}" -f $ip.InterfaceAlias) -ForegroundColor DarkGray
    Write-Host ""
}

Write-Host "After the first visit, this short address works on its own:" -ForegroundColor Cyan
Write-Host ("  http://localhost:{0}/" -f $Port) -ForegroundColor White
Write-Host ""
Write-Host "Keep these links private - anyone holding one can open the dashboard." -ForegroundColor Yellow

Read-Host "`nPress Enter to close"
