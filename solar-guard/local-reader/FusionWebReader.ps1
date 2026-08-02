<#
.SYNOPSIS
    Read live PV / Grid / Load power from the FusionSolar web portal and push it
    into Solar Guard (POST /api/ingest). Pure PowerShell, no Python needed.

.DESCRIPTION
    Why this exists:
      Northbound API needs a dealer account, and Modbus TCP needs SDongle
      firmware SPC127 (this site has SPC116). The web portal is the only channel
      left, so this script talks to the same REST endpoint the Monitoring >
      Overview page calls in the browser.

    Endpoint (confirmed live on 2026-08-02, station NE=50174729):

      GET /rest/pvms/web/station/v3/overview/energy-flow
          ?stationDn=NE%3D50174729&featureId=aifc

    Response shape (data.flow):
      nodes[] - each has id (string), name, description.value like "1.389 kW"
      links[] - each has fromNode / toNode referencing node **id**, plus
                description.value

    IMPORTANT: node "id" is NOT the array index. On this site the 5th node has
    id "5" while its index is 4. Always match links by id, never by position.

    Value mapping, verified against the on-screen numbers three times:
      PV    = node whose name ends with "devTypeLangKey.string"
      Load  = node whose name ends with "kpiView.electricalLoad"
      Grid  = link whose fromNode is the node named "...curInfo.grid"
              (a link pointing TO the grid node means exporting -> negative)
    Cross-check that always held: PV + Grid = Load

    Values arrive as localized strings with a unit ("1.389 kW"), so they are
    parsed unit-aware (W / kW / MW).

.PARAMETER Probe
    Read once, print everything, push nothing. Use this first.

.PARAMETER WorkerUrl
    Solar Guard worker base URL, e.g. https://solar-guard.xxxx.workers.dev

.PARAMETER IngestToken
    Value of INGEST_TOKEN set in Cloudflare. If omitted, read from the
    SOLARGUARD_INGEST_TOKEN environment variable.

.PARAMETER User
    FusionSolar username. If omitted, read from FUSION_USER.

.PARAMETER Password
    FusionSolar password. If omitted, read from FUSION_PASS.
    Prefer the environment variable - do not type the password on a command
    line, it ends up in the PowerShell history file.

.PARAMETER CookieFile
    Alternative to user/password. A text file with one "name=value" cookie per
    line, exported from a browser that is already signed in. Useful if the
    automatic login does not work on this tenant.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\FusionWebReader.ps1 -Probe

.EXAMPLE
    $env:FUSION_USER = "someone"
    $env:FUSION_PASS = "..."
    $env:SOLARGUARD_INGEST_TOKEN = "..."
    powershell -ExecutionPolicy Bypass -File .\FusionWebReader.ps1 `
        -WorkerUrl https://solar-guard.xxxx.workers.dev

.NOTES
    Read-only against FusionSolar. The script only issues GETs for data plus
    the POST needed to sign in. It never changes any setting in the portal.
#>

[CmdletBinding()]
param(
    [string]$Base = "https://sg5.fusionsolar.huawei.com",
    [string]$Station = "NE=50174729",

    [string]$WorkerUrl,
    [string]$IngestToken,

    [string]$User,
    [string]$Password,
    [string]$CookieFile,

    # Encrypted credential store written by Setup-Credentials.ps1. This is the
    # recommended way to run unattended: the password never appears in an
    # environment variable, a command line, or this file. Windows DPAPI ties
    # the file to this user account on this machine - copying it elsewhere
    # makes it useless. Defaults to fusion-cred.xml next to this script.
    [string]$CredentialFile,

    [int]$IntervalSec = 30,
    [ValidateSet(1, -1)][int]$MeterSign = 1,
    [switch]$Probe,
    [switch]$Once,

    # Pull one day's curve from the portal and report when grid import peaked.
    # Answers "what do we actually hit, and at what time" from real history
    # instead of waiting a day for the reader to collect it.
    [switch]$History,
    [string]$Date,

    # Scan a date range and report the worst grid-import moment of each day.
    # Used to find out what actually happened on the days that triggered a
    # tariff penalty, instead of guessing from memory.
    [string]$From,
    [string]$To,
    [string]$LogFile,

    # Read and record, but do not send anywhere. Lets data collection start
    # before the Cloudflare worker exists.
    [switch]$NoPush,

    # Append every reading to a CSV. Survives restarts, and gives you real
    # 15-minute demand history to check against the 30 kW ceiling later.
    [string]$CsvFile,

    # Parse a saved JSON response instead of calling the portal. No sign-in
    # needed. Use it to check the parser after Huawei changes the payload:
    #   .\FusionWebReader.ps1 -Probe -SampleFile .\sample-energy-flow.json
    [string]$SampleFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# Add TLS 1.2/1.3 to whatever the system already allows rather than replacing
# it. Clamping to a single version breaks the moment one endpoint wants
# something else.
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 -bor 12288
} catch {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

# Credential store cache. Declared up front because Set-StrictMode makes
# reading an unset variable a hard error.
$script:SecretStoreLoaded = $false
$script:SecretStore = $null

# Node name suffixes used by the portal. If Huawei renames these, -Probe will
# show the raw names so they can be fixed here in one place.
$PV_SUFFIX   = "devTypeLangKey.string"
$LOAD_SUFFIX = "kpiView.electricalLoad"
$GRID_SUFFIX = "curInfo.grid"

# ---------------------------------------------------------------- helpers ---

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "[{0}] {1} {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    if ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red }
    elseif ($Level -eq "WARN") { Write-Host $line -ForegroundColor Yellow }
    else { Write-Host $line }
    if ($LogFile) {
        try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
    }
}

function ConvertTo-Kw {
    <#  "1.389 kW" -> 1.389   |   "850 W" -> 0.85   |   "" -> $null  #>
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $clean = $Text -replace ",", ""
    $m = [regex]::Match($clean, '(-?\d+(?:\.\d+)?)\s*(MW|kW|W)', 'IgnoreCase')
    if (-not $m.Success) { return $null }
    $value = [double]$m.Groups[1].Value
    switch ($m.Groups[2].Value.ToLower()) {
        "mw" { return $value * 1000 }
        "kw" { return $value }
        "w"  { return $value / 1000 }
    }
    return $null
}

function ConvertFrom-SecureToPlain {
    <# Unwrap a SecureString only for the moment it is needed, then zero it. #>
    param([System.Security.SecureString]$Secure)
    if (-not $Secure) { return $null }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Get-StoredSecrets {
    <#
        Load the DPAPI-encrypted store written by Setup-Credentials.ps1.
        Returns $null when there is no store to read.
    #>
    if ($script:SecretStoreLoaded) { return $script:SecretStore }
    $script:SecretStoreLoaded = $true
    $script:SecretStore = $null

    $path = $CredentialFile
    if (-not $path) { $path = Join-Path $PSScriptRoot "fusion-cred.xml" }
    if (-not (Test-Path $path)) {
        if ($CredentialFile) { throw "CredentialFile not found: $CredentialFile" }
        return $null
    }
    try {
        $store = Import-Clixml -Path $path
    } catch {
        throw ("Could not read {0}: {1}`n" -f $path, $_.Exception.Message) +
              "A credential store can only be decrypted by the same Windows user on the same machine that created it. Re-run Setup-Credentials.ps1."
    }
    Write-Log "Using encrypted credential store: $path"
    $script:SecretStore = $store
    return $store
}

function Test-FusionSession {
    <# The only honest test of a session: ask for real data and see. #>
    param($Session, [string]$BaseUrl)
    try {
        $null = Get-FusionFlow -Session $Session -BaseUrl $BaseUrl -StationDn $Station
        return $true
    } catch {
        return $false
    }
}

function Invoke-UidmLogin {
    <#
        The sign-in flow sg5.fusionsolar.huawei.com actually uses today, taken
        from the portal's own login bundle (pvmswebsite/login/build/login.js,
        method submitLoginApi):

          1. POST /rest/dp/uidm/unisso/v1/validate-user?service=<encoded>
             header  App-Id: smartpvms
             body    {username, password, verifycode}
             -> payload.redirectURL

          2. GET  <redirectURL>?redirectionAddress=<origin><encoded callback>
             headers App-Id, Login-Url-Encode: true
             Following this chain is what actually plants the session cookies.

        App-Id is "pvms" only when brandConfig.common.appidSwitch is set;
        on this tenant it resolves to "smartpvms".

        Returns $true when the chain completed, $false to let the caller fall
        back. It does not decide whether the session really works - the caller
        proves that by asking for data.
    #>
    param($Session, [string]$BaseUrl, [string]$UserName, [string]$Secret)

    $callback = [uri]::EscapeDataString("/rest/dp/uidm/auth/v1/on-sso-credential-ready")
    $loginUrl = "$BaseUrl/rest/dp/uidm/unisso/v1/validate-user?service=$callback"
    $body = @{ username = $UserName; password = $Secret; verifycode = "" } | ConvertTo-Json -Compress

    try {
        $resp = Invoke-WebRequest -Uri $loginUrl -Method POST -Body $body `
            -ContentType "application/json" -WebSession $Session `
            -Headers @{ "App-Id" = "smartpvms" } -UseBasicParsing -TimeoutSec 30
    } catch {
        Write-Log "UIDM sign-in request failed: $($_.Exception.Message)" "WARN"
        return $false
    }

    try { $j = $resp.Content | ConvertFrom-Json } catch { $j = $null }
    if (-not $j) { return $false }

    $redirect = $null
    if ($j.PSObject.Properties.Match("payload").Count -and $j.payload) {
        if ($j.payload.PSObject.Properties.Match("redirectURL").Count) {
            $redirect = $j.payload.redirectURL
        }
    }

    if (-not $redirect) {
        # No redirect means the portal refused. Surface whatever it said -
        # a wrong password and a two-factor prompt look very different here.
        $code = if ($j.PSObject.Properties.Match("code").Count) { $j.code } else { "?" }
        $exId = ""
        if ($j.payload -and $j.payload.PSObject.Properties.Match("exceptionId").Count) {
            $exId = $j.payload.exceptionId
        }
        Write-Log ("UIDM sign-in refused (code {0}{1})" -f $code, $(if ($exId) { ", $exId" } else { "" })) "WARN"
        if ("$exId" -match "verify|twoFactor|vcode") {
            Write-Log "This account looks like it requires a verification code, which cannot be automated. Use -CookieFile." "WARN"
        }
        return $false
    }

    # Step 2 - walk the redirect chain so the session cookies get set.
    #
    # The portal hands back a site-relative path here, not a full URL, and it
    # may already carry a query string. Both have to be handled or the request
    # never leaves the machine.
    $origin = ([uri]$BaseUrl).GetLeftPart([System.UriPartial]::Authority)
    if ($redirect -notmatch '^https?://') {
        if (-not $redirect.StartsWith("/")) { $redirect = "/$redirect" }
        $redirect = $origin.TrimEnd("/") + $redirect
    }
    $sep = if ($redirect.Contains("?")) { "&" } else { "?" }

    $tail = [uri]::EscapeDataString("/rest/pvms/web/login/v1/redirecturl?isFirst=false")
    $url2 = $redirect + $sep + "redirectionAddress=" + [uri]::EscapeDataString($origin) + $tail

    # Log the path only. The query string on this URL carries a one-time
    # sign-in ticket, which does not belong in a log file.
    try { Write-Log ("Following sign-in redirect: {0}" -f ([uri]$url2).AbsolutePath) } catch { }

    try {
        Invoke-WebRequest -Uri $url2 -WebSession $Session -UseBasicParsing -TimeoutSec 30 `
            -Headers @{ "App-Id" = "smartpvms"; "Login-Url-Encode" = "true" } | Out-Null
    } catch {
        # Expected on sg5: the final hop answers with an error after the
        # cookies have already been set. Not a failure on its own - the caller
        # decides by asking for data.
        Write-Log "Redirect chain ended with: $($_.Exception.Message)"
        return $false
    }

    return $true
}

function New-FusionSession {
    <# Build a WebRequestSession, either from a cookie file or by signing in. #>
    param([string]$BaseUrl)

    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $host_ = ([uri]$BaseUrl).Host

    if ($CookieFile) {
        if (-not (Test-Path $CookieFile)) { throw "CookieFile not found: $CookieFile" }
        $count = 0
        foreach ($line in (Get-Content -Path $CookieFile)) {
            $t = $line.Trim()
            if (-not $t -or $t.StartsWith("#")) { continue }
            $i = $t.IndexOf("=")
            if ($i -lt 1) { continue }
            $c = New-Object System.Net.Cookie
            $c.Name = $t.Substring(0, $i).Trim()
            $c.Value = $t.Substring($i + 1).Trim()
            $c.Domain = $host_
            $c.Path = "/"
            $session.Cookies.Add($c)
            $count++
        }
        if ($count -eq 0) { throw "CookieFile has no usable name=value lines" }
        Write-Log "Loaded $count cookies from $CookieFile"
        return $session
    }

    # Preference order: explicit parameters, then the encrypted store, then
    # environment variables. The store is preferred for unattended runs.
    $u = $User
    $p = $Password
    if (-not $u -or -not $p) {
        $store = Get-StoredSecrets
        if ($store -and $store.FusionCredential) {
            if (-not $u) { $u = $store.FusionCredential.UserName }
            if (-not $p) { $p = ConvertFrom-SecureToPlain $store.FusionCredential.Password }
        }
    }
    if (-not $u) { $u = $env:FUSION_USER }
    if (-not $p) { $p = $env:FUSION_PASS }

    if (-not $u -or -not $p) {
        throw @"
No credentials available.

Pick one:
  1. Run Setup-Credentials.ps1 once (recommended - encrypted, unattended).
  2. Set FUSION_USER and FUSION_PASS in this window.
  3. Use -CookieFile with cookies from a signed-in browser.
"@
    }

    # Warm up so the portal hands out its initial cookies.
    try {
        Invoke-WebRequest -Uri "$BaseUrl/unisso/login.action" -WebSession $session `
            -UseBasicParsing -TimeoutSec 30 | Out-Null
    } catch {
        Write-Log "Warm-up request failed (continuing): $($_.Exception.Message)" "WARN"
    }

    # Two sign-in flows exist. UIDM is what sg5 actually runs today; the legacy
    # validateUser.action is kept as a fallback for older regions.
    #
    # The return value below is advisory only. On sg5 the last hop of the UIDM
    # redirect chain answers with an error even though the session cookies were
    # already planted, so a "failed" UIDM attempt is often a working session.
    # Only a real data request settles it - and that matters, because falling
    # back on a false alarm fires a doomed sign-in at the legacy endpoint, which
    # the portal counts as a failed login attempt against this account.
    $null = Invoke-UidmLogin -Session $session -BaseUrl $BaseUrl -UserName $u -Secret $p

    # Counting cookies proves nothing here: the warm-up request above already
    # got cookies from the portal, so that check passes even when the password
    # is wrong. The only honest test is to ask for real data and see if it
    # comes back.
    $verified = Test-FusionSession -Session $session -BaseUrl $BaseUrl

    if (-not $verified) {
        # Only now is a fallback justified.
        Write-Log "UIDM sign-in did not produce a session, trying the legacy endpoint" "WARN"
        $body = @{ organizationName = ""; username = $u; password = $p } | ConvertTo-Json -Compress
        try {
            Invoke-WebRequest -Uri "$BaseUrl/unisso/v2/validateUser.action?decision=1" `
                -Method POST -Body $body -ContentType "application/json" `
                -WebSession $session -UseBasicParsing -TimeoutSec 30 | Out-Null
        } catch {
            Write-Log "Legacy endpoint also failed: $($_.Exception.Message)" "WARN"
        }
        $verified = Test-FusionSession -Session $session -BaseUrl $BaseUrl
    }

    if (-not $verified) {
        throw @"
Sign-in did not produce a working session.

Things to check, in order:
  1. Is the stored password the real portal password?
     Re-run Setup-Credentials.ps1 to replace it.
     (Placeholder text counts as a wrong password.)
  2. Look at the WARN lines above. "UIDM sign-in refused" with a code
     means the portal answered but rejected the attempt.
  3. If the account needs an emailed or texted verification code, no
     script can sign in for you. Use -CookieFile instead.
     See README-FusionWeb.md, section 4.
"@
    }

    Write-Log "Signed in as $u"
    return $session
}

function Get-FusionFlow {
    <# Fetch and parse one sample. Returns a PSCustomObject or throws. #>
    param($Session, [string]$BaseUrl, [string]$StationDn)

    if ($SampleFile) {
        $raw = Get-Content -Path $SampleFile -Raw | ConvertFrom-Json
    }
    else {
        $url = "{0}/rest/pvms/web/station/v3/overview/energy-flow?stationDn={1}&featureId=aifc" -f `
               $BaseUrl, [uri]::EscapeDataString($StationDn)

        $raw = Invoke-RestMethod -Uri $url -WebSession $Session -TimeoutSec 30 `
               -Headers @{ "Accept" = "application/json" }
    }

    # When the session dies the portal answers with the login HTML, not JSON.
    if ($raw -is [string]) { throw "SESSION_EXPIRED" }
    if (-not $raw.PSObject.Properties.Match("data").Count -or $null -eq $raw.data) {
        throw "SESSION_EXPIRED"
    }

    $flow = $raw.data.flow
    $pvNode   = $flow.nodes | Where-Object { $_.name -like "*$PV_SUFFIX" }   | Select-Object -First 1
    $loadNode = $flow.nodes | Where-Object { $_.name -like "*$LOAD_SUFFIX" } | Select-Object -First 1
    $gridNode = $flow.nodes | Where-Object { $_.name -like "*$GRID_SUFFIX" } | Select-Object -First 1

    $pv   = if ($pvNode)   { ConvertTo-Kw $pvNode.description.value }   else { $null }
    $load = if ($loadNode) { ConvertTo-Kw $loadNode.description.value } else { $null }

    # Grid: match links by node id, never by array position.
    $grid = $null
    if ($gridNode) {
        $import = $flow.links | Where-Object { $_.fromNode -eq $gridNode.id } | Select-Object -First 1
        $export = $flow.links | Where-Object { $_.toNode -eq $gridNode.id }   | Select-Object -First 1
        if ($import -and (ConvertTo-Kw $import.description.value) -ne $null) {
            $grid = ConvertTo-Kw $import.description.value
        } elseif ($export -and (ConvertTo-Kw $export.description.value) -ne $null) {
            $grid = -1 * (ConvertTo-Kw $export.description.value)   # selling back
        } else {
            $grid = 0.0
        }
    }

    # Fallback: PV also appears on the inverter -> meter link.
    if ($null -eq $pv -and $pvNode) {
        $l = $flow.links | Where-Object { $_.fromNode -eq $pvNode.id } | Select-Object -First 1
        if ($l) { $pv = ConvertTo-Kw $l.description.value }
    }
    if ($null -eq $pv)   { $pv = 0.0 }
    if ($null -eq $grid) { $grid = 0.0 }
    if ($null -eq $load) { $load = $pv + $grid }

    return [PSCustomObject]@{
        Pv        = $pv
        Grid      = $grid
        Load      = $load
        SceneType = $raw.data.sceneType
        Nodes     = $flow.nodes
        Links     = $flow.links
    }
}

function Get-FusionDay {
    <#
        One day of 5-minute samples from the same endpoint the Energy Trend
        chart uses. The series names are not documented, so this walks whatever
        arrays come back rather than assuming a shape - if Huawei renames
        things, you still get output instead of a crash.
    #>
    param($Session, [string]$BaseUrl, [string]$StationDn, [string]$DayStr)

    $midnight = [datetime]::ParseExact($DayStr, "yyyy-MM-dd", $null)
    $epoch = [int64]([datetimeoffset]::new($midnight, [timespan]::FromHours(7))).ToUnixTimeMilliseconds()

    $url = "{0}/rest/pvms/web/station/v3/overview/energy-balance?stationDn={1}&timeDim=2&queryTime={2}&dateStr={3}&timeZone=7.0&timeZoneStr=Asia/Bangkok" -f `
           $BaseUrl, [uri]::EscapeDataString($StationDn), $epoch, [uri]::EscapeDataString("$DayStr 00:00:00")

    $raw = Invoke-RestMethod -Uri $url -WebSession $Session -TimeoutSec 40 -Headers @{ "Accept" = "application/json" }
    if ($raw -is [string]) { throw "SESSION_EXPIRED" }
    return $raw.data
}

function Push-Sample {
    param([string]$Worker, [string]$Token, [double]$Pv, [double]$Grid, [double]$Load)

    $body = @{
        pv   = [math]::Round($Pv, 3)
        grid = [math]::Round($Grid, 3)
        load = [math]::Round($Load, 3)
    } | ConvertTo-Json -Compress

    return Invoke-RestMethod -Uri ($Worker.TrimEnd("/") + "/api/ingest") -Method POST `
        -Body $body -ContentType "application/json" -TimeoutSec 30 `
        -Headers @{ "X-Ingest-Token" = $Token }
}

# ------------------------------------------------------------------- main ---

$token = $IngestToken
if (-not $token -and -not $Probe) {
    $store = Get-StoredSecrets
    if ($store -and $store.IngestToken) { $token = ConvertFrom-SecureToPlain $store.IngestToken }
}
if (-not $token) { $token = $env:SOLARGUARD_INGEST_TOKEN }

if (-not $Probe -and -not $NoPush -and -not $History -and -not $From) {
    if (-not $WorkerUrl) {
        $store = Get-StoredSecrets
        if ($store -and $store.WorkerUrl) { $WorkerUrl = $store.WorkerUrl }
    }
    if (-not $WorkerUrl) {
        throw "Need -WorkerUrl (store one with Setup-Credentials.ps1, or run with -NoPush to just record locally)"
    }
    if (-not $token) {
        throw "Need -IngestToken (store one with Setup-Credentials.ps1, or run with -NoPush to just record locally)"
    }
}

if ($SampleFile) {
    Write-Log "Offline mode - parsing $SampleFile, not contacting the portal"
    $session = $null
}
else {
    Write-Log "Connecting to $Base"
    $session = New-FusionSession -BaseUrl $Base
}

if ($Probe) {
    try {
        $s = Get-FusionFlow -Session $session -BaseUrl $Base -StationDn $Station
    }
    catch {
        if ($_.Exception.Message -eq "SESSION_EXPIRED") {
            Write-Log "The portal answered with a login page instead of data - not signed in." "ERROR"
            Write-Log "Use -CookieFile to read with an existing browser session (README-FusionWeb.md, section 3)." "ERROR"
            exit 1
        }
        throw
    }
    Write-Host ""
    Write-Host "Raw nodes (id / name / value):"
    foreach ($n in $s.Nodes) {
        "  {0,-3} {1,-52} {2}" -f $n.id, $n.name, $n.description.value | Write-Host
    }
    Write-Host ""
    Write-Host "Raw links (from -> to / value):"
    foreach ($l in $s.Links) {
        "  {0,-3} -> {1,-3} {2}" -f $l.fromNode, $l.toNode, $l.description.value | Write-Host
    }
    Write-Host ""
    Write-Host ("Parsed:  PV {0:N3} kW | Grid {1:N3} kW | Load {2:N3} kW" -f $s.Pv, $s.Grid, $s.Load)
    $diff = [math]::Abs(($s.Pv + $s.Grid) - $s.Load)
    if ($diff -le 0.05) {
        Write-Host ("Check:   PV + Grid = Load  (off by {0:N3} kW) OK" -f $diff) -ForegroundColor Green
    } else {
        Write-Host ("Check:   PV + Grid does NOT equal Load (off by {0:N3} kW)" -f $diff) -ForegroundColor Yellow
        Write-Host "         Compare with the Overview page before trusting this."
    }
    Write-Host ""
    Write-Host "Now open Monitoring > Overview in a browser and confirm the three"
    Write-Host "numbers match. If Grid has the wrong sign, run with -MeterSign -1."
    return
}

if ($From) {
    $start = [datetime]::ParseExact($From, "yyyy-MM-dd", $null)
    $end = if ($To) { [datetime]::ParseExact($To, "yyyy-MM-dd", $null) } else { $start }
    Write-Log ("Scanning {0} to {1} - one sign-in, one request per day" -f $From, $end.ToString("yyyy-MM-dd"))

    Write-Host ""
    Write-Host "  date         peak grid   at      peak load   peak PV   grid kWh-ish"
    Write-Host "  ----------   ---------   -----   ---------   -------   ------------"

    $over20 = @()
    $over30 = @()
    $d = $start
    while ($d -le $end) {
        $ds = $d.ToString("yyyy-MM-dd")
        try {
            $day = Get-FusionDay -Session $session -BaseUrl $Base -StationDn $Station -DayStr $ds
        } catch {
            if ($_.Exception.Message -eq "SESSION_EXPIRED") {
                Write-Log "Session expired mid-scan - signing in again" "WARN"
                $session = New-FusionSession -BaseUrl $Base
                try { $day = Get-FusionDay -Session $session -BaseUrl $Base -StationDn $Station -DayStr $ds }
                catch { Write-Host ("  {0}   (failed)" -f $ds); $d = $d.AddDays(1); continue }
            } else {
                Write-Host ("  {0}   (failed: {1})" -f $ds, $_.Exception.Message)
                $d = $d.AddDays(1); continue
            }
        }

        $grid = $day.meterActivePower
        $load = $day.usePower
        $pv = $day.productPower
        if (-not $grid) { Write-Host ("  {0}   (no data)" -f $ds); $d = $d.AddDays(1); continue }

        $n = $grid.Count
        $maxG = -9999.0; $maxAt = -1; $sumG = 0.0
        for ($i = 0; $i -lt $n; $i++) {
            $o = 0.0
            if ([double]::TryParse([string]$grid[$i], [ref]$o)) {
                if ($o -gt $maxG) { $maxG = $o; $maxAt = $i }
                if ($o -gt 0) { $sumG += $o }
            }
        }
        $minPer = 1440 / $n
        $tm = if ($maxAt -ge 0) { "{0:00}:{1:00}" -f [int](($maxAt * $minPer) / 60), [int](($maxAt * $minPer) % 60) } else { "--:--" }

        function MaxOf { param($arr) $m = 0.0; foreach ($x in $arr) { $o = 0.0; if ([double]::TryParse([string]$x, [ref]$o)) { if ($o -gt $m) { $m = $o } } } return $m }
        $maxL = if ($load) { MaxOf $load } else { 0 }
        $maxP = if ($pv) { MaxOf $pv } else { 0 }
        $kwh = $sumG * ($minPer / 60.0)

        $flag = ""
        if ($maxG -ge 30) { $flag = "  <<< OVER 30"; $over30 += $ds }
        elseif ($maxG -ge 20) { $flag = "  <<  over 20"; $over20 += $ds }

        Write-Host ("  {0}   {1,9:N2}   {2}   {3,9:N2}   {4,7:N2}   {5,12:N1}{6}" -f $ds, $maxG, $tm, $maxL, $maxP, $kwh, $flag)

        $d = $d.AddDays(1)
        Start-Sleep -Milliseconds 400
    }

    Write-Host ""
    Write-Host ("Days peaking at 30 kW or more: {0}" -f $(if ($over30.Count) { $over30 -join ", " } else { "none" }))
    Write-Host ("Days peaking at 20-30 kW:      {0}" -f $(if ($over20.Count) { $over20 -join ", " } else { "none" }))
    Write-Host ""
    Write-Host "Note: this history is 5-minute averages from the portal. A shorter"
    Write-Host "spike between samples would not show up here at all."
    return
}

if ($History) {
    $day = if ($Date) { $Date } else { (Get-Date).ToString("yyyy-MM-dd") }
    Write-Log "Fetching the whole day for $day"
    $d = Get-FusionDay -Session $session -BaseUrl $Base -StationDn $Station -DayStr $day

    # There is no separate time axis. Every series is a flat array covering the
    # whole day at even spacing, so index N is minute N * (1440 / count).
    # Values arrive as strings ("0.000"), which is why they have to be cast.
    $series = @{}
    foreach ($p in $d.PSObject.Properties) {
        $v = $p.Value
        if ($v -is [System.Array] -and $v.Count -ge 24) {
            $ok = 0
            foreach ($x in $v) { $o = 0.0; if ([double]::TryParse([string]$x, [ref]$o)) { $ok++ } }
            if ($ok -gt ($v.Count * 0.6)) { $series[$p.Name] = $v }
        }
    }

    if ($series.Count -eq 0) {
        Write-Host "No numeric series found. Raw shape:"
        ($d | ConvertTo-Json -Depth 3 -Compress) | Write-Host
        return
    }

    $names = @($series.Keys | Sort-Object)
    Write-Host ""
    Write-Host "Series returned by the portal:"
    foreach ($k in $names) { "  {0,-24} {1} points" -f $k, $series[$k].Count | Write-Host }

    function Get-Val { param($arr, $i) $o = 0.0; if ([double]::TryParse([string]$arr[$i], [ref]$o)) { return $o } return $null }

    Write-Host ""
    Write-Host "Hourly average kW (avg / peak within the hour):"
    $hdr = "  hour " + (($names | ForEach-Object { "{0,20}" -f $_.Substring(0, [Math]::Min(20, $_.Length)) }) -join "")
    Write-Host $hdr
    for ($h = 0; $h -le 23; $h++) {
        $row = "  {0:00}   " -f $h
        $any = $false
        foreach ($n in $names) {
            $arr = $series[$n]
            $per = [int]($arr.Count / 24)
            $vals = @()
            for ($i = $h * $per; $i -lt (($h + 1) * $per) -and $i -lt $arr.Count; $i++) {
                $x = Get-Val $arr $i
                if ($null -ne $x) { $vals += $x }
            }
            if ($vals.Count -eq 0) { $row += "{0,20}" -f "-" }
            else {
                $any = $true
                $row += "{0,20}" -f ("{0:N2} / {1:N2}" -f (($vals | Measure-Object -Average).Average), (($vals | Measure-Object -Maximum).Maximum))
            }
        }
        if ($any) { Write-Host $row }
    }
    return
}

if ($NoPush) {
    Write-Log ("Reading every {0}s, recording locally only (no push)" -f $IntervalSec)
} else {
    Write-Log ("Reading every {0}s, pushing to {1}" -f $IntervalSec, $WorkerUrl)
}
if ($CsvFile -and -not (Test-Path $CsvFile)) {
    Set-Content -Path $CsvFile -Value "timestamp,pv_kw,grid_kw,load_kw" -Encoding utf8
}
$fails = 0

# Reading and pushing are kept in separate try blocks on purpose. They fail
# for completely unrelated reasons, and an earlier version treated a 401 from
# the worker as "the FusionSolar session died", which sent it into a re-login
# storm - roughly two sign-ins per second against the portal. Nothing below
# may re-sign-in because of a push error, and no path may skip the sleep.
$relogins = 0
$MAX_RELOGINS = 5

while ($true) {
    $reading = $null

    # ---- read ----
    try {
        $reading = Get-FusionFlow -Session $session -BaseUrl $Base -StationDn $Station
        $relogins = 0
    }
    catch {
        if ($_.Exception.Message -eq "SESSION_EXPIRED") {
            $relogins++
            if ($relogins -gt $MAX_RELOGINS) {
                Write-Log ("Signed in {0} times in a row without getting data. Stopping so this does not hammer the portal or lock the account. Check the password and run -Probe by hand." -f $MAX_RELOGINS) "ERROR"
                exit 1
            }
            Write-Log ("Session expired - signing in again ({0}/{1})" -f $relogins, $MAX_RELOGINS) "WARN"
            try {
                $session = New-FusionSession -BaseUrl $Base
            } catch {
                Write-Log "Re-sign-in failed: $($_.Exception.Message)" "ERROR"
            }
        }
        else {
            $fails++
            Write-Log "Read failed ($fails): $($_.Exception.Message)" "ERROR"
        }
    }

    # ---- record and push ----
    if ($reading) {
        $grid = $MeterSign * $reading.Grid

        if ($CsvFile) {
            $row = "{0},{1:N3},{2:N3},{3:N3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $reading.Pv, $grid, $reading.Load
            try { Add-Content -Path $CsvFile -Value $row -Encoding utf8 } catch { }
        }

        $level = "local"
        if (-not $NoPush) {
            try {
                $res = Push-Sample -Worker $WorkerUrl -Token $token -Pv $reading.Pv -Grid $grid -Load $reading.Load
                $level = if ($res.PSObject.Properties.Match("level").Count) { $res.level } else { "?" }
                $fails = 0
            }
            catch {
                $fails++
                $pushErr = $_.Exception.Message
                $level = "PUSH FAILED"
                if ($pushErr -like "*401*") {
                    Write-Log "Worker rejected the ingest token ($fails). The reader and Cloudflare disagree on INGEST_TOKEN - the reading itself was fine." "ERROR"
                } else {
                    Write-Log "Push failed ($fails): $pushErr" "ERROR"
                }
            }
        } else {
            $fails = 0
        }

        Write-Log ("PV {0,7:N3} kW | Grid {1,7:N3} kW | Load {2,7:N3} kW | {3}" -f `
                   $reading.Pv, $grid, $reading.Load, $level)
    }

    if ($Once) { break }

    # Every path reaches here. Back off on repeated failures, capped at 5 min.
    $wait = [math]::Min($IntervalSec * [math]::Max(1, $fails), 300)
    Start-Sleep -Seconds $wait
}
