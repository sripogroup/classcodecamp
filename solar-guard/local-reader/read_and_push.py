#!/usr/bin/env python3
"""
ตัวอ่านค่าในโรงงาน — อ่านจากอินเวอร์เตอร์ Huawei SUN2000 ตรง ๆ ผ่าน Modbus TCP
แล้วส่งเข้า Solar Guard บน Cloudflare

ทำไมถึงดีกว่าดึงผ่านคลาวด์ของ Huawei:
  - ไม่ต้องใช้บัญชี Northbound API (ไม่ต้องรอดีลเลอร์)
  - ข้อมูลสดระดับวินาที ไม่ใช่ช้า 5-10 นาที ซึ่งสำคัญมากกับหน้าต่าง 15 นาที
  - เน็ตนอกล่มก็ยังอ่านค่าได้ (แค่ส่งออกไม่ได้ชั่วคราว)
  - ไม่มีเพดานจำนวนครั้งที่เรียก

สิ่งที่ต้องมี:
  - เครื่องอะไรก็ได้ในโรงงานที่เปิดค้างไว้และต่อวง LAN เดียวกับอินเวอร์เตอร์
    (คอมเก่า / Raspberry Pi / มินิพีซี)
  - Python 3 + ไลบรารีตัวเดียว:  pip install pymodbus
  - อินเวอร์เตอร์เปิด Modbus TCP ไว้ (ตั้งในแอพ FusionSolar ที่หน้า Device > Settings
    หรือให้ช่างเปิดให้ ปกติพอร์ต 502)

วิธีรัน:
  python read_and_push.py --host 192.168.1.50 \
      --url https://solar-guard.xxxx.workers.dev --token รหัสINGEST_TOKEN

ให้รันค้างไว้ (Windows ใช้ Task Scheduler, Linux ใช้ systemd — ดู README ในโฟลเดอร์นี้)
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

try:
    from pymodbus.client import ModbusTcpClient
except ImportError:
    sys.exit("ยังไม่ได้ติดตั้ง pymodbus — รัน: pip install pymodbus")

# ---------------------------------------------------------------------------
# ทะเบียน Modbus ของ SUN2000
# ตัวเลขพวกนี้เป็นค่ามาตรฐานของ Huawei แต่ **ต้องยืนยันกับของจริงก่อนใช้งานจริง**
# รันด้วย --probe แล้วเทียบกับตัวเลขในแอพ FusionSolar หน้า Overview
# ---------------------------------------------------------------------------
REGISTERS = {
    # ชื่อ: (address, จำนวน register, ตัวหาร, หน่วย)
    "pv_active_power": (32080, 2, 1000, "kW"),      # กำลังไฟที่อินเวอร์เตอร์จ่ายออก (W)
    "meter_active_power": (37113, 2, 1000, "kW"),   # กำลังไฟที่จุดเชื่อมต่อการไฟฟ้า (W)
    "meter_status": (37100, 1, 1, ""),              # 0 = ออฟไลน์, 1 = ปกติ
    "daily_yield": (32114, 2, 100, "kWh"),          # พลังงานที่ผลิตวันนี้
}


def read_i32(client, address, count, slave):
    """อ่านค่าจำนวนเต็มมีเครื่องหมาย 32 บิต (Huawei เรียงแบบ big-endian)"""
    rr = client.read_holding_registers(address, count=count, slave=slave)
    if rr.isError():
        raise IOError(f"อ่าน register {address} ไม่สำเร็จ: {rr}")
    regs = rr.registers
    raw = regs[0] if count == 1 else (regs[0] << 16) | regs[1]
    bits = 16 * count
    if raw >= (1 << (bits - 1)):  # แปลงเป็นค่าติดลบ
        raw -= 1 << bits
    return raw


def read_all(client, slave):
    out = {}
    for name, (addr, count, div, unit) in REGISTERS.items():
        try:
            out[name] = read_i32(client, addr, count, slave) / div
        except Exception as exc:  # อ่านตัวใดตัวหนึ่งไม่ได้ ไม่ควรทำให้ทั้งรอบล่ม
            out[name] = None
            print(f"  ! อ่าน {name} ไม่ได้: {exc}", file=sys.stderr)
    return out


def push(url, token, pv_kw, grid_kw, day_pv=None, timeout=15):
    body = {"pv": round(pv_kw, 3), "grid": round(grid_kw, 3)}
    if day_pv is not None:
        body["dayPv"] = round(day_pv, 2)

    req = urllib.request.Request(
        url.rstrip("/") + "/api/ingest",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Ingest-Token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def main():
    ap = argparse.ArgumentParser(description="อ่านค่าจาก SUN2000 แล้วส่งเข้า Solar Guard")
    ap.add_argument("--host", required=True, help="IP ของอินเวอร์เตอร์ในวง LAN")
    ap.add_argument("--port", type=int, default=502)
    ap.add_argument("--slave", type=int, default=1, help="Modbus unit id (ปกติ 1 หรือ 0)")
    ap.add_argument("--url", help="URL ของ Worker เช่น https://solar-guard.xxx.workers.dev")
    ap.add_argument("--token", help="INGEST_TOKEN ที่ตั้งไว้ใน Cloudflare")
    ap.add_argument("--interval", type=int, default=30, help="ส่งทุกกี่วินาที (ค่าเริ่มต้น 30)")
    ap.add_argument("--meter-sign", type=int, default=1, choices=[1, -1],
                    help="1 = ค่าบวกคือซื้อไฟเข้า, -1 = ค่าบวกคือขายออก")
    ap.add_argument("--probe", action="store_true",
                    help="อ่านค่าครั้งเดียวแล้วแสดงผล ไม่ส่งไปไหน (ใช้ตอนตั้งค่าครั้งแรก)")
    args = ap.parse_args()

    client = ModbusTcpClient(args.host, port=args.port, timeout=10)
    if not client.connect():
        sys.exit(f"ต่อกับอินเวอร์เตอร์ {args.host}:{args.port} ไม่ได้ — เช็ค IP และว่าเปิด Modbus TCP แล้วหรือยัง")

    if args.probe:
        print(f"อ่านค่าจาก {args.host}:{args.port} (slave={args.slave})\n")
        vals = read_all(client, args.slave)
        for name, (addr, _c, _d, unit) in REGISTERS.items():
            print(f"  {name:22s} (reg {addr}) = {vals[name]} {unit}")
        pv, meter = vals.get("pv_active_power"), vals.get("meter_active_power")
        if pv is not None and meter is not None:
            print(f"\n  โหลดรวมที่คำนวณได้ = {pv + meter:.2f} kW")
            print("\n  ✅ เอาเลขพวกนี้ไปเทียบกับหน้า Overview ในแอพ FusionSolar")
            print("     - pv_active_power ควรตรงกับ Output power ของ PV")
            print("     - meter_active_power ควรตรงกับ Current power ฝั่ง Grid")
            print("     - ถ้าเครื่องหมายกลับกัน ให้ใช้ --meter-sign -1")
        client.close()
        return

    if not args.url or not args.token:
        sys.exit("ต้องใส่ --url และ --token (หรือใช้ --probe เพื่อทดสอบการอ่านอย่างเดียว)")

    print(f"เริ่มทำงาน: อ่านจาก {args.host} ส่งเข้า {args.url} ทุก {args.interval} วินาที")
    fails = 0

    while True:
        try:
            if not client.is_socket_open():
                client.connect()

            vals = read_all(client, args.slave)
            pv = vals.get("pv_active_power")
            meter = vals.get("meter_active_power")

            if pv is None or meter is None:
                raise IOError("อ่านค่าหลักไม่ครบ")
            if vals.get("meter_status") == 0:
                print("  ! มิเตอร์แจ้งว่าออฟไลน์ ข้ามรอบนี้", file=sys.stderr)
                time.sleep(args.interval)
                continue

            grid = args.meter_sign * meter
            res = push(args.url, args.token, pv, grid, vals.get("daily_yield"))
            fails = 0
            lvl = res.get("level", "?")
            print(f"[{time.strftime('%H:%M:%S')}] PV {pv:6.2f} kW | ซื้อไฟ {grid:6.2f} kW | สถานะ {lvl}")

        except urllib.error.URLError as exc:
            fails += 1
            print(f"[{time.strftime('%H:%M:%S')}] ส่งไม่สำเร็จ ({fails}): {exc}", file=sys.stderr)
        except Exception as exc:
            fails += 1
            print(f"[{time.strftime('%H:%M:%S')}] ผิดพลาด ({fails}): {exc}", file=sys.stderr)
            try:
                client.close()
            except Exception:
                pass

        # ผิดพลาดติดกันหลายครั้ง ค่อย ๆ ถ่างเวลาออก แต่ไม่เกิน 5 นาที
        time.sleep(min(args.interval * max(1, fails), 300))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nหยุดทำงาน")
