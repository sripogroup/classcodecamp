<#
.SYNOPSIS
    Set up Telegram alerting: store the bot token in Cloudflare, find the group
    chat id automatically, and send a test message to prove it works.

.DESCRIPTION
    Telegram is the channel this system was designed around: sending is free and
    unlimited, so a busy month can never silence the alerts. That matters here
    because one missed peak resets a 12-month clock.

    Before running this you need three things, in this order:

      1. A bot. Open Telegram, search for  @BotFather , send  /newbot ,
         answer its two questions, and it hands you a token that looks like
         1234567890:AAE...  Keep that window open.

      2. A group. Create a Telegram group, add the people who should get the
         alerts, then add your new bot to it the same way you add a person.

      3. One message in that group starting with a slash, for example  /start
         Telegram bots have privacy mode on by default and only see messages
         that start with a slash or mention them - a plain "hello" is invisible
         to the bot, and then this script finds nothing.

    Then run this script and paste the token when asked.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-TelegramSecrets.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-TelegramSecrets.ps1 -ChatId -1001234567890
#>

[CmdletBinding()]
param(
    [string]$WorkerDir = "C:\Users\USER\claude projects\classcodecamp\solar-guard",
    [string]$ChatId,
    [switch]$SkipTest,

    # Show exactly what Telegram returns, and stop. Use when the group is not
    # found even though the bot is clearly in it - the usual hidden cause is a
    # webhook registered on the bot, which makes getUpdates return nothing.
    [switch]$Diagnose,

    # Remove any webhook registered on the bot so getUpdates works again.
    [switch]$ClearWebhook
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

if (-not (Test-Path $WorkerDir)) { throw "Worker directory not found: $WorkerDir" }

Write-Host ""
Write-Host "Solar Guard - Telegram setup" -ForegroundColor Cyan
Write-Host "----------------------------"
Write-Host "Need a token? Open Telegram, message @BotFather, send /newbot"
Write-Host ""

$sec = Read-Host "  Bot token (hidden)" -AsSecureString
if ($sec.Length -eq 0) { throw "No token entered." }
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$token = $token.Trim()

# --- confirm the token is real before storing anything ----------------------
try {
    $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getMe" -TimeoutSec 25
} catch {
    throw ("Telegram rejected that token: {0}`nCheck you copied the whole thing, including the digits before the colon." -f $_.Exception.Message)
}
if (-not $me.ok) { throw "Telegram rejected that token." }
Write-Host ("Bot confirmed: @{0} ({1})" -f $me.result.username, $me.result.first_name) -ForegroundColor Green

# --- clear webhook ----------------------------------------------------------
if ($ClearWebhook) {
    $r = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/deleteWebhook" -TimeoutSec 25
    Write-Host ("deleteWebhook: ok={0} {1}" -f $r.ok, $r.description) -ForegroundColor Green
    Write-Host "Now send /start in the group again, then run this script normally."
    return
}

# --- diagnose ---------------------------------------------------------------
if ($Diagnose) {
    Write-Host ""
    Write-Host "=== getWebhookInfo ===" -ForegroundColor Cyan
    try {
        $wh = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getWebhookInfo" -TimeoutSec 25
        $wh.result | ConvertTo-Json -Depth 4 | Write-Host
        if ($wh.result.url) {
            Write-Host ""
            Write-Host "A webhook is set. While a webhook exists, getUpdates always returns" -ForegroundColor Yellow
            Write-Host "an empty list - that alone explains 'no chats found'." -ForegroundColor Yellow
            Write-Host "Clear it with:  .\Set-TelegramSecrets.ps1 -ClearWebhook" -ForegroundColor Yellow
        }
    } catch { Write-Host ("failed: {0}" -f $_.Exception.Message) -ForegroundColor Red }

    Write-Host ""
    Write-Host "=== getUpdates (raw) ===" -ForegroundColor Cyan
    try {
        $up = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getUpdates" -TimeoutSec 25
        Write-Host ("ok={0}  updates={1}" -f $up.ok, @($up.result).Count)
        foreach ($u in $up.result) {
            $keys = ($u.PSObject.Properties | Where-Object { $_.Name -ne "update_id" } | ForEach-Object { $_.Name }) -join ", "
            Write-Host ("  update_id={0}  keys: {1}" -f $u.update_id, $keys)
        }
        if (@($up.result).Count -gt 0) {
            Write-Host ""
            Write-Host "--- full JSON ---"
            $up.result | ConvertTo-Json -Depth 6 | Write-Host
        }
    } catch { Write-Host ("failed: {0}" -f $_.Exception.Message) -ForegroundColor Red }

    Write-Host ""
    return
}

# --- find the group ---------------------------------------------------------
if (-not $ChatId) {
    Write-Host ""
    Write-Host "Looking for a group the bot can see..." -ForegroundColor Yellow
    $updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getUpdates" -TimeoutSec 25

    $chats = @{}
    foreach ($u in $updates.result) {
        foreach ($k in @("message", "channel_post", "my_chat_member")) {
            if ($u.PSObject.Properties.Match($k).Count -and $u.$k -and $u.$k.chat) {
                $c = $u.$k.chat
                $chats[[string]$c.id] = $c
            }
        }
    }

    if ($chats.Count -eq 0) {
        Write-Host ""
        Write-Host "No chats found. The usual reason:" -ForegroundColor Yellow
        Write-Host "  - nobody has sent a message starting with a slash in the group yet."
        Write-Host "    Bots cannot see ordinary messages. Send  /start  in the group,"
        Write-Host "    then run this again."
        Write-Host "  - or the bot has not been added to the group."
        return
    }

    Write-Host ""
    $i = 0
    $list = @()
    foreach ($id in $chats.Keys) {
        $c = $chats[$id]
        $i++
        $title = if ($c.PSObject.Properties.Match("title").Count -and $c.title) { $c.title } else { "(private chat)" }
        $list += [PSCustomObject]@{ Index = $i; Id = $id; Type = $c.type; Title = $title }
        "  [{0}] {1,-16} {2,-10} {3}" -f $i, $id, $c.type, $title | Write-Host
    }

    $groups = @($list | Where-Object { $_.Type -eq "group" -or $_.Type -eq "supergroup" })
    if ($groups.Count -eq 1) {
        $ChatId = $groups[0].Id
        Write-Host ""
        Write-Host ("Using the only group found: {0}" -f $groups[0].Title) -ForegroundColor Green
    } else {
        Write-Host ""
        $pick = Read-Host "  Which number should get the alerts"
        $chosen = $list | Where-Object { $_.Index -eq [int]$pick }
        if (-not $chosen) { throw "No such number." }
        $ChatId = $chosen.Id
    }
}

Write-Host ("Chat id: {0}" -f $ChatId)

# --- upload both secrets exactly (see the newline note in Set-LineSecrets) ---
$tmp = Join-Path $env:TEMP ("sg-tg-" + [guid]::NewGuid().ToString("N") + ".json")
try {
    @{ TELEGRAM_BOT_TOKEN = $token; TELEGRAM_CHAT_ID = [string]$ChatId } |
        ConvertTo-Json -Compress | Set-Content -Path $tmp -Encoding ascii -NoNewline
    Push-Location $WorkerDir
    try { npx wrangler secret bulk $tmp } finally { Pop-Location }
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
}

# --- prove it actually reaches the group ------------------------------------
if (-not $SkipTest) {
    Write-Host ""
    Write-Host "Sending a test message to the group..." -ForegroundColor Yellow
    $body = @{
        chat_id = $ChatId
        text = "Solar Guard connected. Alerts will arrive here."
    } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/sendMessage" `
             -Method POST -Body $body -ContentType "application/json; charset=utf-8" -TimeoutSec 25
        if ($r.ok) { Write-Host "Sent. Check the group." -ForegroundColor Green }
    } catch {
        Write-Host ("Could not send: {0}" -f $_.Exception.Message) -ForegroundColor Red
        Write-Host "The secrets were still stored. Check the bot is a member of the group."
    }
}

Write-Host ""
Write-Host "Cloudflare needs about 10 seconds to propagate new secrets."
Write-Host "After that, test the whole path end to end with:"
Write-Host "  https://solar-guard.solar-guard.workers.dev/api/test-alert?k=YOUR_DASHBOARD_TOKEN"
Write-Host ""
