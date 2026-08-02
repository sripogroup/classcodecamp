<#
.SYNOPSIS
    Find a Huawei SUN2000 inverter on the local network. No install required.

.DESCRIPTION
    Scans the local subnet(s) for TCP port 502 (Modbus TCP), then reads the
    model name from any host that answers, to confirm it is a Huawei inverter.

    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files using the
    system ANSI codepage, so non-ASCII characters get mangled and break parsing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\FindInverter.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\FindInverter.ps1 -Subnet 192.168.1
#>

[CmdletBinding()]
param(
    [string]$Subnet = "",
    [int]$Port = 502,
    [int]$ScanTimeoutMs = 1500
)

# ---------------------------------------------------------------- subnets

function Get-LocalSubnets {
    $nets = @()
    try {
        $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                 Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }
        foreach ($a in $addrs) {
            $o = $a.IPAddress.Split(".")
            if ($o.Count -eq 4) {
                $prefix = "$($o[0]).$($o[1]).$($o[2])"
                if ($nets -notcontains $prefix) { $nets += $prefix }
            }
        }
    } catch {
        foreach ($m in (ipconfig | Select-String -Pattern "(\d+\.\d+\.\d+)\.\d+")) {
            $prefix = $m.Matches[0].Groups[1].Value
            if ($prefix -notlike "127.*" -and $prefix -notlike "169.254*" -and $nets -notcontains $prefix) {
                $nets += $prefix
            }
        }
    }
    return $nets
}

# ---------------------------------------------------------------- port scan

function Find-OpenPorts {
    param([string]$Prefix, [int]$Port, [int]$TimeoutMs)

    $pending = New-Object System.Collections.ArrayList
    foreach ($i in 1..254) {
        $ip = "$Prefix.$i"
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $async = $client.BeginConnect($ip, $Port, $null, $null)
            [void]$pending.Add([PSCustomObject]@{ IP = $ip; Client = $client; Async = $async })
        } catch { }
    }

    Start-Sleep -Milliseconds $TimeoutMs

    $open = @()
    foreach ($p in $pending) {
        try { if ($p.Async.IsCompleted -and $p.Client.Connected) { $open += $p.IP } } catch { }
        try { $p.Client.Close() } catch { }
    }
    return $open
}

# ---------------------------------------------------------------- modbus

function Read-ModbusRegisters {
    # MBAP + PDU: transaction(2) protocol(2)=0 length(2)=6 unit(1) func(1)=3 addr(2) qty(2)
    param([string]$IP, [int]$Address, [int]$Count, [int]$Unit, [int]$Port = 502)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.SendTimeout = 3000
        $client.ReceiveTimeout = 3000
        $client.Connect($IP, $Port)
        $stream = $client.GetStream()
        Start-Sleep -Milliseconds 300   # some SUN2000 units need a moment after connect

        $req = [byte[]]@(
            0x00, 0x01,
            0x00, 0x00,
            0x00, 0x06,
            [byte]$Unit,
            0x03,
            [byte](($Address -shr 8) -band 0xFF), [byte]($Address -band 0xFF),
            [byte](($Count -shr 8) -band 0xFF), [byte]($Count -band 0xFF)
        )
        $stream.Write($req, 0, $req.Length)
        $stream.Flush()

        # MBAP(7) + function(1) + byteCount(1)
        $head = New-Object byte[] 9
        $got = 0
        while ($got -lt 9) {
            $n = $stream.Read($head, $got, 9 - $got)
            if ($n -le 0) { throw "connection closed" }
            $got += $n
        }

        if ($head[7] -band 0x80) { throw "device returned an exception" }

        $byteCount = $head[8]
        $data = New-Object byte[] $byteCount
        $got = 0
        while ($got -lt $byteCount) {
            $n = $stream.Read($data, $got, $byteCount - $got)
            if ($n -le 0) { throw "short read" }
            $got += $n
        }
        return $data
    } finally {
        try { $client.Close() } catch { }
    }
}

function ConvertTo-CleanText {
    param([byte[]]$Raw)
    $text = [System.Text.Encoding]::ASCII.GetString($Raw)
    $zero = $text.IndexOf([char]0)
    if ($zero -ge 0) { $text = $text.Substring(0, $zero) }
    return $text.Trim()
}

function Get-InverterInfo {
    param([string]$IP, [int]$Port)

    foreach ($unit in @(1, 0)) {
        try {
            $model = ConvertTo-CleanText (Read-ModbusRegisters -IP $IP -Address 30000 -Count 15 -Unit $unit -Port $Port)
            if ([string]::IsNullOrWhiteSpace($model)) { continue }

            $sn = "-"
            try { $sn = ConvertTo-CleanText (Read-ModbusRegisters -IP $IP -Address 30015 -Count 10 -Unit $unit -Port $Port) } catch { }

            $ratedKw = 0
            try {
                $raw = Read-ModbusRegisters -IP $IP -Address 30073 -Count 2 -Unit $unit -Port $Port
                $w = ([int]$raw[0] -shl 24) -bor ([int]$raw[1] -shl 16) -bor ([int]$raw[2] -shl 8) -bor [int]$raw[3]
                $ratedKw = [math]::Round($w / 1000, 1)
            } catch { }

            return [PSCustomObject]@{ IP = $IP; Unit = $unit; Model = $model; SN = $sn; RatedKw = $ratedKw }
        } catch { }
    }
    return [PSCustomObject]@{ IP = $IP; Unit = -1; Model = ""; SN = ""; RatedKw = 0 }
}

# ---------------------------------------------------------------- main

if ($Subnet) {
    $o = $Subnet.Trim().TrimEnd(".").Split(".")
    if ($o.Count -lt 3) {
        Write-Host "Bad -Subnet value. Use e.g.  -Subnet 192.168.1" -ForegroundColor Red
        exit 1
    }
    $subnets = @("$($o[0]).$($o[1]).$($o[2])")
} else {
    $subnets = Get-LocalSubnets
}

if (-not $subnets -or $subnets.Count -eq 0) {
    Write-Host "Could not detect a local subnet." -ForegroundColor Red
    Write-Host "Specify one, e.g.:  .\FindInverter.ps1 -Subnet 192.168.1"
    exit 1
}

Write-Host ""
Write-Host "Scanning for Modbus TCP (port $Port) on: $($subnets -join ', ')" -ForegroundColor Cyan
Write-Host "This takes about 10-30 seconds."
Write-Host ""

$openHosts = @()
foreach ($net in $subnets) {
    Write-Host ("  scanning {0}.1 - {0}.254 ..." -f $net)
    foreach ($ip in (Find-OpenPorts -Prefix $net -Port $Port -TimeoutMs $ScanTimeoutMs)) {
        Write-Host "    port $Port OPEN at $ip" -ForegroundColor Yellow
        $openHosts += $ip
    }
}

if ($openHosts.Count -eq 0) {
    Write-Host ""
    Write-Host "RESULT: nothing is listening on port $Port." -ForegroundColor Red
    Write-Host ""
    Write-Host "Most likely causes, in order:"
    Write-Host "  1. Modbus TCP is not enabled on the inverter   <-- most common"
    Write-Host "     FusionSolar app: Device > (your inverter) > Settings > Communication"
    Write-Host "     Or ask the installer to enable it."
    Write-Host "  2. The inverter is on a different subnet than this server."
    Write-Host "     Check its IP in the app, then re-run:"
    Write-Host "       .\FindInverter.ps1 -Subnet 192.168.x"
    Write-Host "  3. Windows Firewall is blocking outbound connections."
    exit 0
}

Write-Host ""
Write-Host "Checking which of these are Huawei inverters..." -ForegroundColor Cyan
Write-Host ""

$hits = @()
foreach ($ip in $openHosts) {
    $info = Get-InverterInfo -IP $ip -Port $Port
    if ($info.Model) {
        $hits += $info
        $line = "  [FOUND] {0}  model={1}  SN={2}  rated={3} kW  unitId={4}" -f $info.IP, $info.Model, $info.SN, $info.RatedKw, $info.Unit
        Write-Host $line -ForegroundColor Green
    } else {
        Write-Host "  [?]     $ip  port open but did not answer Modbus (probably another device)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host ("=" * 62)
if ($hits.Count -gt 0) {
    $b = $hits[0]
    Write-Host "SUCCESS - send these values back to Claude:" -ForegroundColor Green
    Write-Host ""
    Write-Host "    IP      = $($b.IP)"
    Write-Host "    unitId  = $($b.Unit)"
    Write-Host "    model   = $($b.Model)"
    Write-Host "    rated   = $($b.RatedKw) kW"
} else {
    Write-Host "Port $Port is open on: $($openHosts -join ', ')" -ForegroundColor Yellow
    Write-Host "but none answered as a Huawei inverter. Send these IPs back to Claude."
}
Write-Host ("=" * 62)
Write-Host ""
