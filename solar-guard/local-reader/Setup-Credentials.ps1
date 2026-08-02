<#
.SYNOPSIS
    Store FusionSolar credentials and the Solar Guard ingest token encrypted on
    this machine, so FusionWebReader.ps1 can run unattended without any secret
    sitting in a script, a command line, or an environment variable.

.DESCRIPTION
    You type the password into this prompt. It is held as a SecureString and
    written with Export-Clixml, which encrypts it using Windows DPAPI.

    What that means in practice:
      - only YOUR Windows account, on THIS machine, can decrypt the file
      - copying fusion-cred.xml to another PC makes it useless
      - the password is never echoed to the screen and never enters the
        PowerShell command history

    Run this once. Re-run it any time the password changes.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-Credentials.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-Credentials.ps1 -UserName sripogroup
#>

[CmdletBinding()]
param(
    [string]$UserName = "sripogroup",
    [string]$OutFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $OutFile) { $OutFile = Join-Path $PSScriptRoot "fusion-cred.xml" }

Write-Host ""
Write-Host "Solar Guard - credential setup" -ForegroundColor Cyan
Write-Host "------------------------------"
Write-Host "Nothing you type here is shown on screen or saved to history."
Write-Host "The file is encrypted for this Windows account on this machine only."
Write-Host ""

# --- FusionSolar sign-in -----------------------------------------------------
Write-Host "1) FusionSolar portal sign-in" -ForegroundColor Yellow
$cred = Get-Credential -UserName $UserName -Message "FusionSolar password for $UserName"
if (-not $cred) { throw "Cancelled." }

# --- Solar Guard worker ------------------------------------------------------
Write-Host ""
Write-Host "2) Solar Guard worker (press Enter to skip and fill in later)" -ForegroundColor Yellow
$workerUrl = Read-Host "   Worker URL, e.g. https://solar-guard.xxxx.workers.dev"
$tokenSecure = $null
if ($workerUrl) {
    $tokenSecure = Read-Host "   INGEST_TOKEN (hidden)" -AsSecureString
    if ($tokenSecure.Length -eq 0) { $tokenSecure = $null }
}

$store = [PSCustomObject]@{
    FusionCredential = $cred
    WorkerUrl        = $workerUrl
    IngestToken      = $tokenSecure
    CreatedAt        = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    CreatedBy        = "$env:USERDOMAIN\$env:USERNAME"
    CreatedOn        = $env:COMPUTERNAME
}

$store | Export-Clixml -Path $OutFile

# Tighten the file down to this account only. DPAPI already protects the
# contents; this stops other accounts from even reading the blob.
try {
    $acl = Get-Acl $OutFile
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "$env:USERDOMAIN\$env:USERNAME", "FullControl", "Allow")
    $acl.AddAccessRule($rule)
    Set-Acl -Path $OutFile -AclObject $acl
    $locked = $true
} catch {
    $locked = $false
}

Write-Host ""
Write-Host "Saved: $OutFile" -ForegroundColor Green
if ($locked) { Write-Host "Permissions restricted to $env:USERDOMAIN\$env:USERNAME" -ForegroundColor Green }
else { Write-Host "Note: could not tighten file permissions (contents are still DPAPI-encrypted)." -ForegroundColor Yellow }
Write-Host ""
Write-Host "Next step - check that the sign-in actually works:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\FusionWebReader.ps1`" -Probe"
Write-Host ""
