<#
.SYNOPSIS
    ค้นหาอินเวอร์เตอร์ Huawei SUN2000 ในวง LAN — ไม่ต้องติดตั้งอะไรเลย

.DESCRIPTION
    ใช้ PowerShell ที่มากับ Windows อยู่แล้ว ไม่ต้องลง Python
    จะหาวง LAN ของเครื่องนี้เอง แล้วไล่เช็คทุก IP ว่ามีพอร์ต 502 (Modbus TCP) เปิดอยู่ไหม
    เครื่องที่เปิด จะลองอ่านชื่อรุ่นออกมายืนยันว่าเป็น Huawei จริง

.EXAMPLE
    .\Find-Inverter.ps1

.EXAMPLE
    .\Find-Inverter.ps1 -Subnet 192.168.1

.NOTES
    ถ้ารันไม่ได้เพราะติด execution policy ให้ใช้:
        powershell -ExecutionPolicy Bypass -File .\Find-Inverter.ps1
#>

[CmdletBinding()]
param(
    # ระบุวงเอง เช่น "192.168.1" (ไม่ต้องใส่เลขตัวท้าย) ว่างไว้ = หาเอง
    [string]$Subnet = "",
    [int]$Port = 502,
    [int]$ScanTimeoutMs = 1200
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- หาวง LAN

function Get-LocalSubnets {
    $nets = @()
    try {
        $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                 Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }
        foreach ($a in $addrs) {
            $parts = $a.IPAddress.Split(".")
            if ($parts.Count -eq 4) {
                $prefix = "$($parts[0]).$($parts[1]).$($parts[2])"
                if ($nets -notcontains $prefix) { $nets += $prefix }
            }
        }
    } catch {
        # Windows รุ่นเก่าที่ไม่มี Get-NetIPAddress
        $ipconfig = ipconfig | Select-String -Pattern "IPv4.*?:\s*(\d+\.\d+\.\d+)\.\d+"
        foreach ($m in $ipconfig) {
            $prefix = $m.Matches[0].Groups[1].Value
            if ($prefix -notlike "127.*" -and $nets -notcontains $prefix) { $nets += $prefix }
        }
    }
    return $nets
}

# ---------------------------------------------------------------- สแกนพอร์ต

function Find-OpenPorts {
    param([string]$Prefix, [int]$Port, [int]$TimeoutMs)

    $pending = New-Object System.Collections.ArrayList
    foreach ($i in 1..254) {
        $ip = "$Prefix.$i"
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $async = $client.BeginConnect($ip, $Port, $null, $null)
            [void]$pending.Add([PSCustomObject]@{ IP = $ip; Client = $client; Async = $async })
        } catch {
            $client.Close()
        }
    }

    Start-Sleep -Milliseconds $TimeoutMs

    $open = @()
    foreach ($p in $pending) {
        try {
            if ($p.Async.IsCompleted -and $p.Client.Connected) { $open += $p.IP }
        } catch { }
        try { $p.Client.Close() } catch { }
    }
    return $open
}

# ---------------------------------------------------------------- อ่าน Modbus

function Read-ModbusRegisters {
    <#
      อ่าน holding registers ผ่าน Modbus TCP แบบดิบ ๆ
      โครง: transaction(2) protocol(2)=0 length(2)=6 unit(1) function(1)=3 addr(2) qty(2)
    #>
    param([string]$IP, [int]$Address, [int]$Count, [int]$Unit, [int]$Port = 502)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.SendTimeout = 3000
        $client.ReceiveTimeout = 3000
        $client.Connect($IP, $Port)
        $stream = $client.GetStream()
        Start-Sleep -Milliseconds 300   # SUN2000 บางรุ่นต้องรอสักครู่หลังเชื่อมต่อ

        $req = [byte[]]@(
            0x00, 0x01,                                     # transaction id
            0x00, 0x00,                                     # protocol id = 0
            0x00, 0x06,                                     # ความยาวส่วนที่เหลือ
            [byte]$Unit,
            0x03,                                           # function 3 = read holding registers
            [byte](($Address -shr 8) -band 0xFF), [byte]($Address -band 0xFF),
            [byte](($Count -shr 8) -band 0xFF), [byte]($Count -band 0xFF)
        )
        $stream.Write($req, 0, $req.Length)
        $stream.Flush()

        # อ่านหัว 9 ไบต์: MBAP(7) + function(1) + byteCount(1)
        $head = New-Object byte[] 9
        $got = 0
        while ($got -lt 9) {
            $n = $stream.Read($head, $got, 9 - $got)
            if ($n -le 0) { throw "อีกฝั่งปิดการเชื่อมต่อ" }
            $got += $n
        }

        $func = $head[7]
        if ($func -band 0x80) { throw "อุปกรณ์ปฏิเสธคำขอ (exception)" }

        $byteCount = $head[8]
        $data = New-Object byte[] $byteCount
        $got = 0
        while ($got -lt $byteCount) {
            $n = $stream.Read($data, $got, $byteCount - $got)
            if ($n -le 0) { throw "ข้อมูลขาดกลางคัน" }
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

            $ratedKw = $null
            try {
                $raw = Read-ModbusRegisters -IP $IP -Address 30073 -Count 2 -Unit $unit -Port $Port
                $w = ([int]$raw[0] -shl 24) -bor ([int]$raw[1] -shl 16) -bor ([int]$raw[2] -shl 8) -bor [int]$raw[3]
                $ratedKw = [math]::Round($w / 1000, 1)
            } catch { }

            return [PSCustomObject]@{ IP = $IP; Unit = $unit; Model = $model; SN = $sn; RatedKw = $ratedKw }
        } catch { }
    }
    return [PSCustomObject]@{ IP = $IP; Unit = $null; Model = $null; SN = $null; RatedKw = $null }
}

# ---------------------------------------------------------------- เริ่มทำงาน

if ($Subnet) {
    # รับได้ทั้ง "192.168.1" และ "192.168.1.50" — เอาแค่ 3 ชุดแรกเสมอ
    $octets = $Subnet.Trim().TrimEnd(".").Split(".")
    if ($octets.Count -lt 3) {
        Write-Host "รูปแบบไม่ถูกต้อง ใช้แบบนี้:  .\Find-Inverter.ps1 -Subnet 192.168.1" -ForegroundColor Red
        exit 1
    }
    $subnets = @("$($octets[0]).$($octets[1]).$($octets[2])")
} else {
    $subnets = Get-LocalSubnets
}

if (-not $subnets -or $subnets.Count -eq 0) {
    Write-Host "หาวง LAN ของเครื่องนี้ไม่เจอ" -ForegroundColor Red
    Write-Host "ระบุเองได้ เช่น:  .\Find-Inverter.ps1 -Subnet 192.168.1"
    exit 1
}

Write-Host ""
Write-Host "กำลังค้นหาอินเวอร์เตอร์ในวง: $($subnets -join ', ')" -ForegroundColor Cyan
Write-Host "(ใช้เวลาประมาณ 10-30 วินาที)"
Write-Host ""

$openHosts = @()
foreach ($net in $subnets) {
    Write-Host "  สแกน $net.1 - $net.254 ..."
    $found = Find-OpenPorts -Prefix $net -Port $Port -TimeoutMs $ScanTimeoutMs
    foreach ($ip in $found) {
        Write-Host "    พบพอร์ต $Port เปิดอยู่ที่ $ip" -ForegroundColor Yellow
        $openHosts += $ip
    }
}

if ($openHosts.Count -eq 0) {
    Write-Host ""
    Write-Host "ไม่พบอุปกรณ์ที่เปิดพอร์ต $Port เลย" -ForegroundColor Red
    Write-Host ""
    Write-Host "สาเหตุที่พบบ่อย เรียงตามโอกาส:"
    Write-Host "  1. ยังไม่ได้เปิด Modbus TCP ที่อินเวอร์เตอร์  <- ข้อนี้บ่อยที่สุด"
    Write-Host "     เปิดในแอพ FusionSolar: Device > เลือกอินเวอร์เตอร์ > Settings > Communication"
    Write-Host "     หรือแจ้งช่างที่ติดตั้งให้เปิดให้"
    Write-Host "  2. อินเวอร์เตอร์อยู่คนละวง LAN กับเครื่องนี้"
    Write-Host "     ดู IP ของอินเวอร์เตอร์ในแอพ แล้วรันใหม่:  .\Find-Inverter.ps1 -Subnet 192.168.x"
    Write-Host "  3. Windows Firewall บล็อกขาออกอยู่"
    exit 0
}

Write-Host ""
Write-Host "กำลังตรวจว่าเป็น Huawei หรือไม่..." -ForegroundColor Cyan
Write-Host ""

$hits = @()
foreach ($ip in $openHosts) {
    $info = Get-InverterInfo -IP $ip -Port $Port
    if ($info.Model) {
        $hits += $info
        $rated = if ($info.RatedKw) { " | ขนาด $($info.RatedKw) kW" } else { "" }
        Write-Host "  [เจอ] $($info.IP)  รุ่น $($info.Model)  (SN $($info.SN)$rated)  unit id = $($info.Unit)" -ForegroundColor Green
    } else {
        Write-Host "  [?]  $ip  เปิดพอร์ต $Port แต่อ่านชื่อรุ่นไม่ได้ (น่าจะเป็นอุปกรณ์อื่น)" -ForegroundColor DarkGray
    }
}

if ($hits.Count -gt 0) {
    $best = $hits[0]
    Write-Host ""
    Write-Host ("=" * 62)
    Write-Host "เจอแล้ว! ส่งข้อมูลนี้กลับไปให้ Claude:" -ForegroundColor Green
    Write-Host ""
    Write-Host "    IP      = $($best.IP)"
    Write-Host "    unit id = $($best.Unit)"
    Write-Host "    รุ่น     = $($best.Model)"
    Write-Host ""
    Write-Host "ขั้นถัดไปคืออ่านค่ากำลังไฟจริงออกมาเทียบกับหน้า Overview"
    Write-Host ("=" * 62)
} else {
    Write-Host ""
    Write-Host "มีเครื่องเปิดพอร์ต $Port อยู่ แต่ไม่ตอบแบบ Huawei" -ForegroundColor Yellow
    Write-Host "ส่ง IP พวกนี้กลับไปให้ Claude ดู: $($openHosts -join ', ')"
}
