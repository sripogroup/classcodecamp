<#
.SYNOPSIS
    Read live PV and grid power straight from the SUN2000 inverter over
    Modbus TCP on the LAN, and push it into Solar Guard.

.DESCRIPTION
    Replaces FusionWebReader.ps1 as the primary data path.

    Why this is better than the web portal:
      - Values are live. The portal only refreshes its numbers about every
        5 minutes, which eats a third of the 15-minute window the utility
        bills on before anyone can react.
      - No shared session. The portal allows ONE login at a time, so any
        other sign-in silently breaks the reader. On 2026-08-03 that produced
        a 1,279 kW reading that poisoned the day peak, the month peak and
        the 15-minute window at once.
      - No cloud round trip, so it keeps working when the internet is down
        (readings queue in the CSV either way).

    Site facts confirmed on 2026-08-03:
      inverter  SUN2000-36KTL-M3   SN 6T2139026297   rated 36 kW
      dongle    SDongleA-05  V200R022C10SPC200  Modbus TCP: Enable (unrestricted)
      address   192.168.1.26:502   unit id 1

    SIGN CONVENTION - the important part:
      Register 37113 on this site reads NEGATIVE while importing. Verified
      against the portal at the same moment:

        Modbus  reg 37113 = -4588 W        portal: buying 4.415 kW
        Modbus  reg 32080 =  8221 W        portal: PV    8.563 kW
        derived load = 8.221 + 4.588 = 12.809 kW   portal: load 12.978 kW

      So grid_import_kW = -(reg37113 / 1000), i.e. -MeterSign -1.
      Getting this backwards makes the system believe the site is exporting
      around the clock, and it would then never raise an alarm at all.

.PARAMETER Probe
    Read once, print everything including the raw registers, push nothing.
    Run this first and compare against the FusionSolar Overview page.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\ModbusReader.ps1 -Probe

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\ModbusReader.ps1 `
        -LogFile "$env:USERPROFILE\solar-guard-modbus.log" `
        -CsvFile "$env:USERPROFILE\solar-guard-readings-modbus.csv"

.NOTES
    Read-only against the inverter. Function code 0x03 (read holding
    registers) only - this script never writes a register, so it cannot
    change an inverter setting even by accident.
#>

[CmdletBinding()]
param(
    [string]$IP = "192.168.1.26",
    [int]$Port = 502,
    [int]$Unit = 1,

    # -1 because this site reports grid import as a negative number.
    # See the sign discussion in the header before changing it.
    [ValidateSet(1, -1)][int]$MeterSign = -1,

    [string]$WorkerUrl,
    [string]$IngestToken,
    [string]$CredentialFile,

    # How often to read the inverter. The registers themselves update about
    # once a second; 5 s is responsive without hammering the single Modbus slot.
    [int]$IntervalSec = 5,

    # How often to send upstream. Reading fast and sending slower keeps the
    # request count sane (30 s = ~2,900 requests/day) while still catching
    # short spikes, because the value sent is built from every read in between.
    [int]$PushEverySec = 30,

    # Send immediately, without waiting for the timer, once grid import
    # reaches this. Being late on a real spike is the one failure this whole
    # system exists to prevent.
    [double]$PushNowKw = 15,

    # Anything above this is a fault, not power. A 36 kW inverter against a
    # 20 kW ceiling can never produce a three-digit reading.
    [double]$MaxPlausibleKw = 100,

    [switch]$Probe,
    [switch]$Once,
    [switch]$NoPush,
    [string]$LogFile,
    [string]$CsvFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 -bor 12288
} catch {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

# Register map. Addresses are Huawei's documented SUN2000 holding registers.
$REG_MODEL     = 30000; $LEN_MODEL   = 15
$REG_SN        = 30015; $LEN_SN      = 10
$REG_RATED_W   = 30073
$REG_PV_W      = 32080   # inverter AC output, int32 W
$REG_METER_ST  = 37100   # 1 = meter present and talking
$REG_METER_W   = 37113   # grid active power, int32 W

$script:SecretStoreLoaded = $false
$script:SecretStore = $null
$script:Client = $null
$script:Stream = $null
$script:Txn = 0

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

function ConvertFrom-SecureToPlain {
    param([System.Security.SecureString]$Secure)
    if (-not $Secure) { return $null }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Get-StoredSecrets {
    if ($script:SecretStoreLoaded) { return $script:SecretStore }
    $script:SecretStoreLoaded = $true
    $script:SecretStore = $null
    $path = $CredentialFile
    if (-not $path) { $path = Join-Path $PSScriptRoot "fusion-cred.xml" }
    if (-not (Test-Path $path)) { return $null }
    try { $script:SecretStore = Import-Clixml -Path $path } catch { return $null }
    return $script:SecretStore
}

# ----------------------------------------------------------------- modbus ---

function Connect-Inverter {
    <#
        SUN2000 units accept one client at a time and dislike rapid
        reconnects, so the connection is opened once and reused. It also
        needs a moment after TCP connect before it will answer, and it
        commonly drops the very first request.
    #>
    Disconnect-Inverter

    $c = New-Object System.Net.Sockets.TcpClient
    $c.SendTimeout = 5000
    $c.ReceiveTimeout = 5000
    $c.Connect($IP, $Port)
    $script:Client = $c
    $script:Stream = $c.GetStream()
    Start-Sleep -Milliseconds 2000

    # Throwaway read so the real one is not the first.
    try { $null = Invoke-ModbusRead -Address $REG_MODEL -Count 2 } catch { }
    Write-Log "Connected to $IP`:$Port (unit $Unit)"
}

function Disconnect-Inverter {
    if ($script:Stream) { try { $script:Stream.Close() } catch { } }
    if ($script:Client) { try { $script:Client.Close() } catch { } }
    $script:Stream = $null
    $script:Client = $null
}

function Invoke-ModbusRead {
    <# Function code 0x03 only. Returns the raw data bytes, or throws. #>
    param([int]$Address, [int]$Count)

    if (-not $script:Stream) { throw "not connected" }
    $script:Txn = ($script:Txn + 1) -band 0xFFFF

    $req = [byte[]]@(
        [byte](($script:Txn -shr 8) -band 0xFF), [byte]($script:Txn -band 0xFF),
        0x00, 0x00, 0x00, 0x06, [byte]$Unit, 0x03,
        [byte](($Address -shr 8) -band 0xFF), [byte]($Address -band 0xFF),
        [byte](($Count -shr 8) -band 0xFF), [byte]($Count -band 0xFF)
    )

    # Drop anything stale still sitting in the buffer, otherwise a late reply
    # from a previous request gets read as the answer to this one.
    while ($script:Stream.DataAvailable) { $null = $script:Stream.ReadByte() }

    $script:Stream.Write($req, 0, $req.Length)
    $script:Stream.Flush()

    $head = New-Object byte[] 9
    $got = 0
    while ($got -lt 9) {
        $n = $script:Stream.Read($head, $got, 9 - $got)
        if ($n -le 0) { throw "connection closed by device" }
        $got += $n
    }
    if ($head[7] -band 0x80) { throw "modbus exception code $($head[8])" }

    $byteCount = $head[8]
    $data = New-Object byte[] $byteCount
    $got = 0
    while ($got -lt $byteCount) {
        $n = $script:Stream.Read($data, $got, $byteCount - $got)
        if ($n -le 0) { throw "short read" }
        $got += $n
    }
    return $data
}

function ConvertTo-Int32 {
    param([byte[]]$Data)
    $v = ([int64]$Data[0] -shl 24) -bor ([int64]$Data[1] -shl 16) -bor ([int64]$Data[2] -shl 8) -bor [int64]$Data[3]
    if ($v -ge 2147483648) { $v -= 4294967296 }
    return [double]$v
}

function ConvertTo-Int16Val {
    param([byte[]]$Data)
    $v = ([int]$Data[0] -shl 8) -bor [int]$Data[1]
    if ($v -ge 32768) { $v -= 65536 }
    return $v
}

function ConvertTo-Text {
    param([byte[]]$Data)
    $t = [System.Text.Encoding]::ASCII.GetString($Data)
    $z = $t.IndexOf([char]0)
    if ($z -ge 0) { $t = $t.Substring(0, $z) }
    return $t.Trim()
}

function Read-Now {
    <#
        One full reading. Returns PV / Grid / Load in kW, already sign-corrected
        so that Grid is POSITIVE when buying from the utility - the same
        convention FusionWebReader.ps1 pushes, so both readers are interchangeable.
    #>
    $pvW = ConvertTo-Int32 (Invoke-ModbusRead -Address $REG_PV_W -Count 2)
    $mW  = ConvertTo-Int32 (Invoke-ModbusRead -Address $REG_METER_W -Count 2)

    $pv = [math]::Round($pvW / 1000.0, 3)
    $grid = [math]::Round(($MeterSign * $mW) / 1000.0, 3)

    return [pscustomobject]@{
        Pv      = $pv
        Grid    = $grid
        Load    = [math]::Round($pv + $grid, 3)
        RawPvW  = $pvW
        RawMetW = $mW
    }
}

function Test-Plausible {
    param($Reading)
    $worst = ([math]::Abs($Reading.Pv)), ([math]::Abs($Reading.Grid)), ([math]::Abs($Reading.Load)) |
             Measure-Object -Maximum | Select-Object -ExpandProperty Maximum
    return $worst -le $MaxPlausibleKw
}

function Push-Sample {
    param([double]$Pv, [double]$Grid, [double]$Load)
    $body = @{
        pv   = [math]::Round($Pv, 3)
        grid = [math]::Round($Grid, 3)
        load = [math]::Round($Load, 3)
    } | ConvertTo-Json -Compress
    return Invoke-RestMethod -Uri ($WorkerUrl.TrimEnd("/") + "/api/ingest") -Method POST `
        -Body $body -ContentType "application/json" -TimeoutSec 30 `
        -Headers @{ "X-Ingest-Token" = $IngestToken }
}

# ------------------------------------------------------------------- main ---

if (-not $IngestToken) {
    $store = Get-StoredSecrets
    if ($store -and $store.IngestToken) { $IngestToken = ConvertFrom-SecureToPlain $store.IngestToken }
}
if (-not $IngestToken) { $IngestToken = $env:SOLARGUARD_INGEST_TOKEN }
if (-not $WorkerUrl) {
    $store = Get-StoredSecrets
    if ($store -and $store.WorkerUrl) { $WorkerUrl = $store.WorkerUrl }
}

if (-not $Probe -and -not $NoPush) {
    if (-not $WorkerUrl) { throw "Need -WorkerUrl (or run Setup-Credentials.ps1), or pass -NoPush" }
    if (-not $IngestToken) { throw "Need -IngestToken (or run Setup-Credentials.ps1), or pass -NoPush" }
}

if ($CsvFile -and -not (Test-Path $CsvFile)) {
    Set-Content -Path $CsvFile -Value "timestamp,pv_kw,grid_kw,load_kw" -Encoding utf8
}

# ---- probe: read once, show everything, send nothing ----
if ($Probe) {
    Connect-Inverter
    try {
        $model = ConvertTo-Text (Invoke-ModbusRead -Address $REG_MODEL -Count $LEN_MODEL)
        $sn    = ConvertTo-Text (Invoke-ModbusRead -Address $REG_SN -Count $LEN_SN)
        $rated = ConvertTo-Int32 (Invoke-ModbusRead -Address $REG_RATED_W -Count 2)
        $mst   = ConvertTo-Int16Val (Invoke-ModbusRead -Address $REG_METER_ST -Count 1)
        $r     = Read-Now

        Write-Host ""
        Write-Host ("=" * 62)
        Write-Host "  model        : $model"
        Write-Host "  serial       : $sn"
        Write-Host ("  rated        : {0:N0} W" -f $rated)
        Write-Host ("  meter status : {0}  {1}" -f $mst, $(if ($mst -eq 1) { "(meter online)" } else { "(CHECK - meter not reporting)" }))
        Write-Host ""
        Write-Host ("  raw reg 32080 (PV)    = {0,10:N0} W" -f $r.RawPvW)
        Write-Host ("  raw reg 37113 (meter) = {0,10:N0} W" -f $r.RawMetW)
        Write-Host ("  MeterSign applied     = {0}" -f $MeterSign)
        Write-Host ""
        Write-Host ("  PV    = {0,8:N3} kW" -f $r.Pv) -ForegroundColor Green
        Write-Host ("  Grid  = {0,8:N3} kW   {1}" -f $r.Grid, $(if ($r.Grid -ge 0) { "(buying from utility)" } else { "(exporting)" })) -ForegroundColor Yellow
        Write-Host ("  Load  = {0,8:N3} kW   (PV + Grid)" -f $r.Load) -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Compare these against the FusionSolar Overview page right now."
        Write-Host "  If Grid has the wrong sign, re-run with -MeterSign $(-$MeterSign)."
        Write-Host ("=" * 62)
        Write-Host ""
        if (-not (Test-Plausible $r)) {
            Write-Log "Reading is outside the plausible range - check MaxPlausibleKw and the register map" "WARN"
        }
    } finally {
        Disconnect-Inverter
    }
    return
}

# ---- normal run: read fast, push on a slower cadence ----
Write-Log ("Reading every {0}s, pushing every {1}s (or at once above {2} kW)" -f $IntervalSec, $PushEverySec, $PushNowKw)
if ($NoPush) { Write-Log "NoPush: recording locally only" }

$acc = New-Object System.Collections.ArrayList   # readings since the last push
$lastPush = [datetime]::MinValue
$fails = 0

while ($true) {
    $reading = $null
    try {
        if (-not $script:Client -or -not $script:Client.Connected) { Connect-Inverter }
        $reading = Read-Now
        $fails = 0
    } catch {
        $fails++
        Write-Log ("Read failed ({0}): {1}" -f $fails, $_.Exception.Message) "WARN"
        Disconnect-Inverter
        # Back off a little so a flapping link does not turn into a tight loop.
        Start-Sleep -Seconds ([math]::Min(60, $IntervalSec * $fails))
        if ($Once) { break }
        continue
    }

    if (-not (Test-Plausible $reading)) {
        Write-Log ("Impossible reading, skipped: PV {0:F3} / Grid {1:F3} / Load {2:F3} kW (raw pv={3} meter={4})" -f `
            $reading.Pv, $reading.Grid, $reading.Load, $reading.RawPvW, $reading.RawMetW) "WARN"
        Start-Sleep -Seconds $IntervalSec
        if ($Once) { break }
        continue
    }

    if ($CsvFile) {
        # F3, never N3: "N" inserts thousands separators, which split a value
        # across two CSV columns and silently shift every field after it.
        $row = "{0},{1:F3},{2:F3},{3:F3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $reading.Pv, $reading.Grid, $reading.Load
        try { Add-Content -Path $CsvFile -Value $row -Encoding utf8 } catch { }
    }

    [void]$acc.Add($reading)

    $sincePush = ((Get-Date) - $lastPush).TotalSeconds
    $urgent = $reading.Grid -ge $PushNowKw
    $due = $sincePush -ge $PushEverySec

    if (-not $NoPush -and ($due -or ($urgent -and $sincePush -ge 5))) {
        # Normal cadence sends the MEAN of everything read since the last push,
        # which is what the utility's 15-minute average is built from.
        # An urgent send uses the instantaneous value instead, because that is
        # the number the "right now" ceiling is judged on and averaging it
        # away would defeat the point of sending early.
        if ($urgent) {
            $pv = $reading.Pv; $grid = $reading.Grid; $load = $reading.Load
        } else {
            $pv   = ($acc | Measure-Object -Property Pv   -Average).Average
            $grid = ($acc | Measure-Object -Property Grid -Average).Average
            $load = ($acc | Measure-Object -Property Load -Average).Average
        }

        try {
            $res = Push-Sample -Pv $pv -Grid $grid -Load $load
            $lastPush = Get-Date
            [void]$acc.Clear()
            $lvl = if ($res -and $res.PSObject.Properties.Name -contains "level") { $res.level } else { "sent" }
            Write-Log ("PV {0,7:F3} kW | Grid {1,7:F3} kW | Load {2,7:F3} kW | {3}{4}" -f `
                $pv, $grid, $load, $lvl, $(if ($urgent) { " [URGENT]" } else { "" }))
        } catch {
            Write-Log ("Push failed: {0}" -f $_.Exception.Message) "ERROR"
            # Keep the accumulator so the next successful push still represents
            # the whole gap rather than only the last few seconds.
            $lastPush = Get-Date
        }
    }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSec
}

Disconnect-Inverter
