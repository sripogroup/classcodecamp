<#
.SYNOPSIS
    Deep probe of a single Modbus TCP host. Use after FindInverter.ps1 locates a
    device on port 502 that did not answer the quick check.

.DESCRIPTION
    Huawei SUN2000 inverters are picky Modbus servers:
      - they need 1-3 seconds after TCP connect before they will answer
      - they accept only ONE connection at a time, and refuse rapid reconnects
      - the first request after connecting is often dropped
      - the unit/slave id is not always 1 (SDongle setups often use 0, and
        multi-inverter sites use 2, 3, ...)
    A fast parallel port scan can also leave the single connection slot busy.

    This script therefore probes ONE host slowly and patiently: it waits after
    connecting, retries, and walks through several unit ids and registers,
    printing raw bytes so nothing is hidden.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\ProbeInverter.ps1 -IP 192.168.1.26

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\ProbeInverter.ps1 -IP 192.168.1.26 -SettleMs 3000
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$IP,
    [int]$Port = 502,
    [int]$SettleMs = 2000,        # how long to wait after connect before asking
    [int]$GapMs = 1200,           # pause between connections (inverter needs it)
    [int]$Attempts = 2,           # retries per combination
    [int[]]$Units = @(1, 0, 2, 3, 16, 247)
)

# Registers worth trying. name, address, count, kind
$PROBES = @(
    @{ Name = "model_name";    Addr = 30000; Count = 15; Kind = "text" }
    @{ Name = "serial_number"; Addr = 30015; Count = 10; Kind = "text" }
    @{ Name = "rated_power_W"; Addr = 30073; Count = 2;  Kind = "int32" }
    @{ Name = "pv_power_W";    Addr = 32080; Count = 2;  Kind = "int32" }
    @{ Name = "meter_status";  Addr = 37100; Count = 1;  Kind = "int16" }
    @{ Name = "meter_power_W"; Addr = 37113; Count = 2;  Kind = "int32" }
)

function Show-Mac {
    param([string]$IP)
    try {
        # populate the ARP cache first
        $null = Test-Connection -ComputerName $IP -Count 1 -Quiet -ErrorAction SilentlyContinue
        $line = (arp -a $IP | Select-String -Pattern "([0-9a-fA-F]{2}[-:]){5}[0-9a-fA-F]{2}")
        if ($line) {
            $mac = $line.Matches[0].Value.ToUpper().Replace(":", "-")
            Write-Host "  MAC address : $mac"
            $oui = $mac.Substring(0, 8)
            $huawei = @("00-E0-FC","00-18-82","00-25-9E","04-BD-70","0C-37-DC","10-47-80",
                        "20-0B-C7","24-69-A5","28-6E-D4","34-6B-D3","40-CB-A8","44-6A-2E",
                        "48-46-FB","4C-1F-CC","54-89-98","5C-4C-A9","5C-63-BF","68-A0-F6",
                        "70-72-3C","78-D7-52","80-B6-86","84-A8-E4","88-53-D4","9C-28-EF",
                        "A4-99-47","AC-4E-91","B4-15-13","C0-70-09","C4-05-28","D0-2D-B3",
                        "DC-D2-FC","E0-24-7F","E4-68-A3","F4-9F-F3","F8-01-13")
            if ($huawei -contains $oui) {
                Write-Host "  vendor      : HUAWEI (confirmed by MAC prefix)" -ForegroundColor Green
            } else {
                Write-Host "  vendor      : unknown prefix $oui - send this to Claude" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  MAC address : not found in ARP cache"
        }
    } catch {
        Write-Host "  MAC address : lookup failed"
    }
}

function Invoke-ModbusRead {
    param([string]$IP, [int]$Port, [int]$Address, [int]$Count, [int]$Unit,
          [int]$SettleMs, [switch]$Warmup)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.SendTimeout = 5000
        $client.ReceiveTimeout = 5000
        $client.Connect($IP, $Port)
        $stream = $client.GetStream()
        Start-Sleep -Milliseconds $SettleMs

        $req = [byte[]]@(
            0x00, 0x01, 0x00, 0x00, 0x00, 0x06, [byte]$Unit, 0x03,
            [byte](($Address -shr 8) -band 0xFF), [byte]($Address -band 0xFF),
            [byte](($Count -shr 8) -band 0xFF), [byte]($Count -band 0xFF)
        )

        # Many SUN2000 units drop the very first request after connecting.
        if ($Warmup) {
            try {
                $stream.Write($req, 0, $req.Length); $stream.Flush()
                Start-Sleep -Milliseconds 500
                while ($stream.DataAvailable) { $null = $stream.ReadByte() }
            } catch { }
        }

        $stream.Write($req, 0, $req.Length)
        $stream.Flush()

        $head = New-Object byte[] 9
        $got = 0
        while ($got -lt 9) {
            $n = $stream.Read($head, $got, 9 - $got)
            if ($n -le 0) { return @{ Ok = $false; Why = "connection closed by device" } }
            $got += $n
        }

        if ($head[7] -band 0x80) {
            return @{ Ok = $false; Why = "modbus exception code $($head[8])" }
        }

        $byteCount = $head[8]
        $data = New-Object byte[] $byteCount
        $got = 0
        while ($got -lt $byteCount) {
            $n = $stream.Read($data, $got, $byteCount - $got)
            if ($n -le 0) { return @{ Ok = $false; Why = "short read" } }
            $got += $n
        }
        return @{ Ok = $true; Data = $data }
    } catch {
        return @{ Ok = $false; Why = $_.Exception.Message }
    } finally {
        try { $client.Close() } catch { }
    }
}

function Format-Value {
    param([byte[]]$Data, [string]$Kind)
    switch ($Kind) {
        "text" {
            $t = [System.Text.Encoding]::ASCII.GetString($Data)
            $z = $t.IndexOf([char]0)
            if ($z -ge 0) { $t = $t.Substring(0, $z) }
            return $t.Trim()
        }
        "int32" {
            $v = ([int]$Data[0] -shl 24) -bor ([int]$Data[1] -shl 16) -bor ([int]$Data[2] -shl 8) -bor [int]$Data[3]
            if ($v -ge 2147483648) { $v -= 4294967296 }
            return "$v"
        }
        "int16" {
            $v = ([int]$Data[0] -shl 8) -bor [int]$Data[1]
            if ($v -ge 32768) { $v -= 65536 }
            return "$v"
        }
    }
}

# ---------------------------------------------------------------- main

Write-Host ""
Write-Host "Probing $IP`:$Port" -ForegroundColor Cyan
Write-Host ("-" * 62)
Show-Mac -IP $IP
Write-Host ""
Write-Host "Trying unit ids: $($Units -join ', ')   (settle ${SettleMs}ms, gap ${GapMs}ms)"
Write-Host "This is deliberately slow. Allow 1-3 minutes."
Write-Host ""

$goodUnit = -1

# Stage 1: find a unit id that answers anything at all
foreach ($unit in $Units) {
    Write-Host ("  unit {0,-4} " -f $unit) -NoNewline
    $answered = $false

    for ($try = 1; $try -le $Attempts; $try++) {
        $r = Invoke-ModbusRead -IP $IP -Port $Port -Address 30000 -Count 15 -Unit $unit -SettleMs $SettleMs -Warmup
        if ($r.Ok) {
            $text = Format-Value -Data $r.Data -Kind "text"
            $hex = ($r.Data | ForEach-Object { $_.ToString("x2") }) -join ""
            Write-Host "ANSWERED" -ForegroundColor Green
            Write-Host "             model text : '$text'"
            Write-Host "             raw hex    : $hex"
            $goodUnit = $unit
            $answered = $true
            break
        }
        Start-Sleep -Milliseconds $GapMs
    }

    if (-not $answered) { Write-Host "no answer ($($r.Why))" -ForegroundColor DarkGray }
    if ($goodUnit -ge 0) { break }
    Start-Sleep -Milliseconds $GapMs
}

Write-Host ""

if ($goodUnit -lt 0) {
    Write-Host ("=" * 62)
    Write-Host "RESULT: device on port $Port did not answer any Modbus request." -ForegroundColor Red
    Write-Host ""
    Write-Host "What this usually means:"
    Write-Host "  1. Modbus TCP is present but locked to a single client, and"
    Write-Host "     something else is already connected (the FusionSolar dongle"
    Write-Host "     itself, or a previous run). Power-cycle nothing - just wait"
    Write-Host "     2 minutes and run this again."
    Write-Host "  2. Modbus TCP is disabled and the open port belongs to something else."
    Write-Host "     FusionSolar app: Device > (inverter) > Settings > Communication"
    Write-Host "  3. The device is not a Huawei inverter at all. Check the MAC vendor above."
    Write-Host ""
    Write-Host "Send this whole output back to Claude."
    Write-Host ("=" * 62)
    exit 0
}

# Stage 2: read the values that actually matter
Write-Host "Reading live values using unit id $goodUnit ..." -ForegroundColor Cyan
Write-Host ""

$results = @{}
foreach ($p in $PROBES) {
    Start-Sleep -Milliseconds $GapMs
    $r = Invoke-ModbusRead -IP $IP -Port $Port -Address $p.Addr -Count $p.Count -Unit $goodUnit -SettleMs $SettleMs -Warmup
    if ($r.Ok) {
        $val = Format-Value -Data $r.Data -Kind $p.Kind
        $hex = ($r.Data | ForEach-Object { $_.ToString("x2") }) -join ""
        $results[$p.Name] = $val
        Write-Host ("  {0,-16} reg {1,-6} = {2,-24} [hex {3}]" -f $p.Name, $p.Addr, $val, $hex) -ForegroundColor Green
    } else {
        Write-Host ("  {0,-16} reg {1,-6} = FAILED ({2})" -f $p.Name, $p.Addr, $r.Why) -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host ("=" * 62)
Write-Host "SUMMARY - send this back to Claude" -ForegroundColor Green
Write-Host ""
Write-Host "    IP      = $IP"
Write-Host "    unitId  = $goodUnit"
if ($results.ContainsKey("model_name"))    { Write-Host "    model   = $($results['model_name'])" }
if ($results.ContainsKey("pv_power_W"))    { Write-Host ("    PV      = {0} kW" -f ([math]::Round([double]$results['pv_power_W'] / 1000, 3))) }
if ($results.ContainsKey("meter_power_W")) { Write-Host ("    Grid    = {0} kW" -f ([math]::Round([double]$results['meter_power_W'] / 1000, 3))) }
if ($results.ContainsKey("pv_power_W") -and $results.ContainsKey("meter_power_W")) {
    $load = ([double]$results['pv_power_W'] + [double]$results['meter_power_W']) / 1000
    Write-Host ("    Load    = {0} kW  (PV + Grid)" -f [math]::Round($load, 3))
    Write-Host ""
    Write-Host "Compare these against the FusionSolar Overview page right now."
}
Write-Host ("=" * 62)
Write-Host ""
