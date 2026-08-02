#!/usr/bin/env python3
"""
ค้นหาอินเวอร์เตอร์ Huawei SUN2000 ในวง LAN

รันบนเครื่องที่โรงงาน (เครื่องเดียวกับที่จะใช้เป็นตัวอ่านค่า):

    python find_inverter.py

ไม่ต้องติดตั้งอะไรเลย ใช้แต่ของที่มากับ Python

สคริปต์นี้จะ:
  1. หาว่าเครื่องนี้อยู่วง LAN ไหน
  2. ไล่เช็คทุก IP ในวงว่ามีพอร์ต 502 (Modbus TCP) เปิดอยู่ไหม
  3. เครื่องที่เปิด จะลองอ่านชื่อรุ่นออกมาดูว่าใช่ Huawei หรือเปล่า

ถ้าไม่เจออะไรเลย ไม่ได้แปลว่าอินเวอร์เตอร์ไม่มี — ส่วนใหญ่แปลว่า
ยังไม่ได้เปิด Modbus TCP หรืออยู่คนละวง LAN (ดูหัวข้อ "ถ้าไม่เจอ" ท้ายผลลัพธ์)
"""

import concurrent.futures
import ipaddress
import socket
import struct
import sys
import time

MODBUS_PORT = 502
CONNECT_TIMEOUT = 0.4
READ_TIMEOUT = 2.5

# ทะเบียนของ SUN2000 ที่ใช้ยืนยันตัวตน
REG_MODEL = (30000, 15)  # ชื่อรุ่น เก็บเป็นข้อความ
REG_SN = (30015, 10)     # หมายเลขเครื่อง
REG_RATED = (30073, 2)   # กำลังผลิตสูงสุดที่ออกแบบไว้ (W)


def local_subnets():
    """เดาวง LAN ของเครื่องนี้จาก IP ที่ใช้ออกเน็ต"""
    nets = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # ไม่ได้ส่งอะไรจริง แค่ให้ OS บอกว่าใช้ IP ไหนออก
        ip = s.getsockname()[0]
        s.close()
        nets.append(ipaddress.ip_network(f"{ip}/24", strict=False))
    except OSError:
        pass

    # เผื่อเครื่องมีหลายวง ลองดูจากชื่อโฮสต์ด้วย
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip.startswith("127."):
                continue
            net = ipaddress.ip_network(f"{ip}/24", strict=False)
            if net not in nets:
                nets.append(net)
    except OSError:
        pass

    return nets


def port_open(ip, port=MODBUS_PORT, timeout=CONNECT_TIMEOUT):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((str(ip), port)) == 0


def modbus_read(ip, address, count, unit, timeout=READ_TIMEOUT):
    """
    อ่าน holding registers ผ่าน Modbus TCP แบบดิบ ๆ ไม่ต้องพึ่งไลบรารี

    โครง MBAP + PDU:
      transaction(2) protocol(2)=0 length(2) unit(1) function(1)=3 addr(2) qty(2)
    """
    req = struct.pack(">HHHBBHH", 1, 0, 6, unit, 3, address, count)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect((str(ip), MODBUS_PORT))
        time.sleep(0.3)  # SUN2000 บางรุ่นต้องรอสักครู่หลังเชื่อมต่อก่อนจะตอบ
        s.sendall(req)

        header = b""
        while len(header) < 8:
            chunk = s.recv(8 - len(header))
            if not chunk:
                raise IOError("อีกฝั่งปิดการเชื่อมต่อ")
            header += chunk

        _tid, proto, length, _unit, func = struct.unpack(">HHHBB", header)
        if proto != 0:
            raise IOError("ไม่ใช่ Modbus TCP")
        if func & 0x80:  # บิตสูงติด = ฝั่งนั้นตอบว่า error
            code = s.recv(1)
            raise IOError(f"อุปกรณ์ปฏิเสธคำขอ (exception {code[0] if code else '?'})")

        remaining = length - 2  # หัก unit กับ function ที่อ่านไปแล้ว
        body = b""
        while len(body) < remaining:
            chunk = s.recv(remaining - len(body))
            if not chunk:
                raise IOError("ข้อมูลขาดกลางคัน")
            body += chunk

        byte_count = body[0]
        return body[1 : 1 + byte_count]


def as_text(raw):
    return raw.split(b"\x00")[0].decode("ascii", errors="ignore").strip()


def identify(ip):
    """ลองอ่านข้อมูลรุ่นออกมา ลองทั้ง unit id 0 และ 1"""
    for unit in (1, 0):
        try:
            model = as_text(modbus_read(ip, *REG_MODEL, unit=unit))
            if not model:
                continue
            info = {"ip": str(ip), "unit": unit, "model": model}
            try:
                info["sn"] = as_text(modbus_read(ip, *REG_SN, unit=unit))
            except Exception:
                info["sn"] = "-"
            try:
                raw = modbus_read(ip, *REG_RATED, unit=unit)
                info["rated_kw"] = struct.unpack(">i", raw[:4])[0] / 1000
            except Exception:
                info["rated_kw"] = None
            return info
        except Exception:
            continue
    return {"ip": str(ip), "unit": None, "model": None}


def main():
    targets = []
    if len(sys.argv) > 1:
        # ระบุวงเองได้ เช่น  python find_inverter.py 192.168.1.0/24
        for arg in sys.argv[1:]:
            targets.append(ipaddress.ip_network(arg, strict=False))
    else:
        targets = local_subnets()

    if not targets:
        sys.exit("หาวง LAN ของเครื่องนี้ไม่เจอ — ระบุเองได้ เช่น: python find_inverter.py 192.168.1.0/24")

    print("กำลังค้นหาอินเวอร์เตอร์ในวง:", ", ".join(str(n) for n in targets))
    print("(ใช้เวลาประมาณ 10-30 วินาที)\n")

    found_ports = []
    for net in targets:
        hosts = list(net.hosts())
        with concurrent.futures.ThreadPoolExecutor(max_workers=128) as pool:
            results = pool.map(lambda ip: (ip, port_open(ip)), hosts)
            for ip, is_open in results:
                if is_open:
                    found_ports.append(ip)
                    print(f"  พบพอร์ต 502 เปิดอยู่ที่ {ip}")

    if not found_ports:
        print("\n❌ ไม่พบอุปกรณ์ที่เปิดพอร์ต 502 เลย\n")
        print("สาเหตุที่พบบ่อย เรียงตามโอกาส:")
        print("  1. ยังไม่ได้เปิด Modbus TCP ที่อินเวอร์เตอร์")
        print("     เปิดในแอพ FusionSolar: Device > เลือกอินเวอร์เตอร์ > Settings > Communication")
        print("     หรือแจ้งช่างที่ติดตั้งให้เปิดให้")
        print("  2. อินเวอร์เตอร์อยู่คนละวง LAN กับเครื่องนี้")
        print("     เช็ค IP ของอินเวอร์เตอร์ในแอพ แล้วรันใหม่โดยระบุวงเอง:")
        print("       python find_inverter.py 192.168.x.0/24")
        print("  3. มีไฟร์วอลล์บนเครื่องนี้บล็อกอยู่")
        return

    print("\nกำลังตรวจว่าเป็น Huawei หรือไม่...\n")
    hits = []
    for ip in found_ports:
        info = identify(ip)
        if info["model"]:
            hits.append(info)
            rated = f" | ขนาด {info['rated_kw']} kW" if info.get("rated_kw") else ""
            print(f"  ✅ {info['ip']}  รุ่น {info['model']}  (SN {info['sn']}{rated})  unit id = {info['unit']}")
        else:
            print(f"  ❓ {info['ip']}  เปิดพอร์ต 502 แต่อ่านชื่อรุ่นไม่ได้ (อาจเป็นอุปกรณ์อื่น)")

    if hits:
        best = hits[0]
        print("\n" + "=" * 60)
        print("🎉 เจอแล้ว! ขั้นตอนถัดไป — ทดสอบอ่านค่าจริง:\n")
        print(f"    pip install pymodbus")
        print(f"    python read_and_push.py --host {best['ip']} --slave {best['unit']} --probe")
        print("\nแล้วเอาตัวเลขที่ได้ไปเทียบกับหน้า Overview ในแอพ FusionSolar")
        print("=" * 60)
    else:
        print("\n⚠️ มีเครื่องเปิดพอร์ต 502 แต่ไม่ตอบแบบ Huawei")
        print("   ลองรัน probe ตรง ๆ ดูก็ได้:")
        for ip in found_ports:
            print(f"     python read_and_push.py --host {ip} --probe")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nยกเลิก")
