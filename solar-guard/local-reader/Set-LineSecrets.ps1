<#
.SYNOPSIS
    Copy the LINE channel access token from the existing LINE hub app into
    Cloudflare Worker secrets, and prompt for the channel secret.

.DESCRIPTION
    The token is 172 characters long. Copying it by hand invites a silent typo
    that only shows up later as a 401 nobody can explain, so this reads it
    straight from the hub's config.json and uploads it without ever printing it.

    Why "secret bulk" and not "secret put": piping a value into secret put on
    PowerShell appends a newline, so the value stored in Cloudflare does not
    match the value you think you set. That cost real debugging time once
    already. secret bulk takes a JSON file and stores the value exactly.

    The temporary JSON file is deleted immediately, including on failure.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-LineSecrets.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-LineSecrets.ps1 -SkipChannelSecret
#>

[CmdletBinding()]
param(
    [string]$HubConfig = "C:\Users\USER\claude projects\app 3490 LINE hub_placeholder\config.json",
    [string]$WorkerDir = "C:\Users\USER\claude projects\classcodecamp\solar-guard",
    [switch]$SkipToken,
    [switch]$SkipChannelSecret
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The hub folder name contains Thai characters, which cannot live in this
# ASCII-only file. Find it by pattern instead of hard-coding the name.
if (-not (Test-Path $HubConfig)) {
    $root = "C:\Users\USER\claude projects"
    $found = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -like "app 3490*" } |
             ForEach-Object { Join-Path $_.FullName "config.json" } |
             Where-Object { Test-Path $_ } |
             Select-Object -First 1
    if ($found) { $HubConfig = $found }
}

if (-not (Test-Path $WorkerDir)) { throw "Worker directory not found: $WorkerDir" }

$secrets = @{}

# --- channel access token (read from the hub, never displayed) ---------------
if (-not $SkipToken) {
    if (-not (Test-Path $HubConfig)) {
        throw "Could not find the LINE hub config.json. Pass -HubConfig with the full path."
    }
    $cfg = Get-Content -Path $HubConfig -Raw | ConvertFrom-Json
    $token = $null
    if ($cfg.PSObject.Properties.Match("line").Count -and $cfg.line) {
        if ($cfg.line.PSObject.Properties.Match("channelAccessToken").Count) {
            $token = [string]$cfg.line.channelAccessToken
        }
    }
    if (-not $token) { throw "No line.channelAccessToken found in $HubConfig" }

    $secrets["LINE_CHANNEL_TOKEN"] = $token
    Write-Host ("Read channel access token from the hub config ({0} characters)." -f $token.Length) -ForegroundColor Green
}

# --- channel secret (typed by you, hidden) ----------------------------------
if (-not $SkipChannelSecret) {
    Write-Host ""
    Write-Host "Channel secret - LINE Developers Console > your Messaging API channel" -ForegroundColor Yellow
    Write-Host "  > Basic settings > Channel secret" -ForegroundColor Yellow
    Write-Host "This is what proves an incoming webhook really came from LINE."
    Write-Host "Press Enter to skip."
    $sec = Read-Host "  Channel secret (hidden)" -AsSecureString
    if ($sec.Length -gt 0) {
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { $secrets["LINE_CHANNEL_SECRET"] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    } else {
        Write-Host "Skipped. The webhook will accept unsigned requests until this is set." -ForegroundColor Yellow
    }
}

if ($secrets.Count -eq 0) { Write-Host "Nothing to upload."; return }

$tmp = Join-Path $env:TEMP ("sg-line-" + [guid]::NewGuid().ToString("N") + ".json")
try {
    $secrets | ConvertTo-Json -Compress | Set-Content -Path $tmp -Encoding ascii -NoNewline
    Push-Location $WorkerDir
    try {
        npx wrangler secret bulk $tmp
    } finally {
        Pop-Location
    }
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
}

Write-Host ""
Write-Host "Done. Secrets uploaded:" -ForegroundColor Green
foreach ($k in $secrets.Keys) { Write-Host ("  {0}" -f $k) }
Write-Host ""
Write-Host "Cloudflare takes about 10 seconds to propagate a new secret."
Write-Host "If a test fails right away, wait and try once more before assuming it is wrong."
