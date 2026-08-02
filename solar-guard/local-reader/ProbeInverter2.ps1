<#
.SYNOPSIS
    Second-generation probe. Use after ProbeInverter.ps1 reported
    "An established connection was aborted by the software in your host machine".

.DESCRIPTION
    That error appears on the Write() call, which means the TCP connect
    SUCCEEDED and the socket was then closed before we sent anything.
    In other words the device hangs up during the wait - so waiting longer
    is exactly the wrong move. The first probe waited 2000 ms; this one
    sends immediately and sweeps progressively longer waits to find the
    window that actually works.

    Confirmed already: 1C:43:63 is registered to Huawei Technologies, so the
    device at this address is a Huawei unit (inverter or SDongle).

    Stage 0 measures how long the connection survives with no traffic.
    Stage 1 finds a wait value where a request can be sent and answered.
    Stage 2 sweeps unit ids using that wait value.
    Stage 3 reads the live power values.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\ProbeInverter2.ps1 -IP 192.168.1.26
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$IP,
    [int]$Port = 502,
    [int]$GapMs = 1500,
    [int[]]$Units = @(1, 0, 2, 3, 16, 100, 247),
    [int[]]$Settles = @(0, 50, 200, 600, 1500)
)

function New-ModbusRequest {
    param([int]$Unit, [int]$Address, [int]$Count)
    return [byte[]]@(
        0x00, 0x01, 0x00, 0x00, 0x00, 0x06, [byte]$Unit, 0x03,
        [byte](($Address -shr 8) -band 0xFF), [byte]($Address -band 0xFF),
        [byte](($Count -shr 8) -band 0xFF), [byte]($Count -band 0xFF)
    )
}

function Invoke-Read {
    param([string]$IP, [int]$Port, [int]$Unit, [int]$Address, [int]$Count, [int]$SettleMs)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.NoDelay = $true
        $client.SendTimeout = 6000
        $client.ReceiveTimeout = 6000
        $client.Connect($IP, $Port)
        $stream = $client.GetStream()

        if ($SettleMs -gt 0) { Start-Sleep -Milliseconds $SettleMs }

        $req = New-ModbusRequest -Unit $Unit -Address $Address -Count $Count
        $stream.Write($req, 0, $req.Length)
        $stream.Flush()

        $head = New-Object byte[] 9
        $got = 0
        while ($got -lt 9) {
            $n = $stream.Read($head, $got, 9 - $got)
            if ($n -le 0) { return @{ Ok = $false; Stage = "read"; Why = "device closed after our request" } }
            $got += $n
        }
        if ($head[7] -band 0x80) {
            return @{ Ok = $false; Stage = "modbus"; Why = "exception code $($head[8])" }
        }

        $byteCount = $head[8]
        $data = New-Object byte[] $byteCount
        $got = 0
        while ($got -lt $byteCount) {
            $n = $stream.Read($data, $got, $byteCount - $got)
            if ($n -le 0) { return @{ Ok = $false; Stage = "read"; Why = "short read" } }
            $got += $n
        }
        return @{ Ok = $true; Data = $data }
    } catch {
        $msg = $_.Exception.Message
        $stage = "write"
        if ($msg -match "aborted|reset|forcibly") { $stage = "dropped" }
        if ($msg -match "refused|No connection could be made") { $stage = "connect" }
        return @{ Ok = $false; Stage = $stage; Why = $msg }
    } finally {
        try { $client.Close() } catch { }
    }
}

function Get-Hex { param([byte[]]$D) return (($D | ForEach-Object { $_.ToString("x2") }) -join "") }

function Get-Text {
    param([byte[]]$D)
    $t = [System.Text.Encoding]::ASCII.GetString($D)
    $z = $t.IndexOf([char]0)
    if ($z -ge 0) { $t = $t.Substring(0, $z) }
    return $t.Trim()
}

function Get-Int32 {
    param([byte[]]$D)
    $v = ([int64]$D[0] -shl 24) -bor ([int64]$D[1] -shl 16) -bor ([int64]$D[2] -shl 8) -bor [int64]$D[3]
    if ($v -ge 2147483648) { $v -= 4294967296 }
    return $v
}

# ---------------------------------------------------------------- stage 0

Write-Host ""
Write-Host "Probe 2 - target $IP`:$Port" -ForegroundColor Cyan
Write-Host "MAC prefix 1C:43:63 is registered to Huawei Technologies (already confirmed)."
Write-Host ("-" * 64)
Write-Host ""
Write-Host "STAGE 0 - how long does the connection stay open if we send nothing?" -ForegroundColor Cyan

$lifetimeMs = -1
try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect($IP, $Port)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 6000) {
        Start-Sleep -Milliseconds 100
        # Poll(0, SelectRead) true + 0 bytes available means the peer closed
        if ($c.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $c.Client.Available -eq 0) {
            $lifetimeMs = [int]$sw.ElapsedMilliseconds
            break
        }
    }
    $sw.Stop()
    $c.Close()
} catch {
    Write-Host "  connect failed: $($_.Exception.Message)" -ForegroundColor Red
}

if ($lifetimeMs -ge 0) {
    Write-Host "  device closed the idle connection after about $lifetimeMs ms" -ForegroundColor Yellow
    Write-Host "  -> we must send our request faster than that"
} else {
    Write-Host "  connection stayed open for at least 6 seconds" -ForegroundColor Green
    Write-Host "  -> the drop is not a plain idle timeout"
}

# ---------------------------------------------------------------- stage 1

Write-Host ""
Write-Host "STAGE 1 - find a wait time where a request gets through" -ForegroundColor Cyan
Write-Host ""

$bestSettle = -1
$bestUnit = -1

foreach ($s in $Settles) {
    foreach ($u in @(1, 0)) {
        Write-Host ("  wait {0,5} ms, unit {1,-4} " -f $s, $u) -NoNewline
        $r = Invoke-Read -IP $IP -Port $Port -Unit $u -Address 30000 -Count 15 -SettleMs $s
        if ($r.Ok) {
            Write-Host "ANSWERED" -ForegroundColor Green
            Write-Host ("             text '{0}'  hex {1}" -f (Get-Text $r.Data), (Get-Hex $r.Data))
            $bestSettle = $s; $bestUnit = $u
            break
        }
        Write-Host ("{0} ({1})" -f $r.Stage.ToUpper(), $r.Why.Substring(0, [Math]::Min(58, $r.Why.Length))) -ForegroundColor DarkGray
        Start-Sleep -Milliseconds $GapMs
    }
    if ($bestSettle -ge 0) { break }
}

if ($bestSettle -lt 0) {
    Write-Host ""
    Write-Host ("=" * 64)
    Write-Host "RESULT: the Huawei device accepts TCP but never answers Modbus." -ForegroundColor Red
    Write-Host ""
    Write-Host "Read the STAGE 1 column above:"
    Write-Host "  all DROPPED  -> Modbus TCP is switched off, or this port belongs"
    Write-Host "                  to the FusionSolar dongle service rather than Modbus."
    Write-Host "                  Fix in the app: Device > (inverter) > Settings >"
    Write-Host "                  Communication > enable Modbus TCP."
    Write-Host "                  On some firmware it is under the SDongle, and some"
    Write-Host "                  builds only allow it while connected to the"
    Write-Host "                  inverter's own WLAN hotspot."
    Write-Host "  all MODBUS   -> Modbus works but the unit id is wrong. Re-run with"
    Write-Host "                  -Units 4,5,6,7,8 to widen the search."
    Write-Host ""
    Write-Host "Send this whole output back to Claude."
    Write-Host ("=" * 64)
    exit 0
}

# ---------------------------------------------------------------- stage 2

Write-Host ""
Write-Host "STAGE 2 - confirming unit id (wait = $bestSettle ms)" -ForegroundColor Cyan
Write-Host ""

$goodUnit = $bestUnit
foreach ($u in $Units) {
    if ($u -eq $bestUnit) { continue }
    Start-Sleep -Milliseconds $GapMs
    $r = Invoke-Read -IP $IP -Port $Port -Unit $u -Address 30000 -Count 15 -SettleMs $bestSettle
    if ($r.Ok -and (Get-Text $r.Data)) {
        Write-Host ("  unit {0,-4} also answers: '{1}'" -f $u, (Get-Text $r.Data)) -ForegroundColor DarkGray
    }
}
Write-Host "  using unit id $goodUnit" -ForegroundColor Green

# ---------------------------------------------------------------- stage 3

Write-Host ""
Write-Host "STAGE 3 - live values" -ForegroundColor Cyan
Write-Host ""

$probes = @(
    @{ N = "model_name";    A = 30000; C = 15; K = "text" }
    @{ N = "serial_number"; A = 30015; C = 10; K = "text" }
    @{ N = "rated_power";   A = 30073; C = 2;  K = "int32" }
    @{ N = "pv_power";      A = 32080; C = 2;  K = "int32" }
    @{ N = "meter_status";  A = 37100; C = 1;  K = "raw" }
    @{ N = "meter_power";   A = 37113; C = 2;  K = "int32" }
)

$vals = @{}
foreach ($p in $probes) {
    Start-Sleep -Milliseconds $GapMs
    $r = Invoke-Read -IP $IP -Port $Port -Unit $goodUnit -Address $p.A -Count $p.C -SettleMs $bestSettle
    if ($r.Ok) {
        switch ($p.K) {
            "text"  { $v = Get-Text $r.Data }
            "int32" { $v = Get-Int32 $r.Data }
            default { $v = Get-Hex $r.Data }
        }
        $vals[$p.N] = $v
        Write-Host ("  {0,-14} reg {1,-6} = {2,-22} [hex {3}]" -f $p.N, $p.A, $v, (Get-Hex $r.Data)) -ForegroundColor Green
    } else {
        Write-Host ("  {0,-14} reg {1,-6} = FAILED ({2})" -f $p.N, $p.A, $r.Stage) -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host ("=" * 64)
Write-Host "SUMMARY - send this back to Claude" -ForegroundColor Green
Write-Host ""
Write-Host "    IP       = $IP"
Write-Host "    unitId   = $goodUnit"
Write-Host "    waitMs   = $bestSettle"
if ($vals.ContainsKey("model_name")) { Write-Host "    model    = $($vals['model_name'])" }
if ($vals.ContainsKey("pv_power"))    { Write-Host ("    PV       = {0} kW" -f ([math]::Round($vals['pv_power'] / 1000.0, 3))) }
if ($vals.ContainsKey("meter_power")) { Write-Host ("    Grid     = {0} kW" -f ([math]::Round($vals['meter_power'] / 1000.0, 3))) }
if ($vals.ContainsKey("pv_power") -and $vals.ContainsKey("meter_power")) {
    Write-Host ("    Load     = {0} kW  (PV + Grid)" -f ([math]::Round(($vals['pv_power'] + $vals['meter_power']) / 1000.0, 3)))
    Write-Host ""
    Write-Host "Open the FusionSolar Overview page now and compare these three numbers."
}
Write-Host ("=" * 64)
Write-Host ""
