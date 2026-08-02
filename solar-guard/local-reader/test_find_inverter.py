#!/usr/bin/env python3
"""
ทดสอบตัวค้นหาอินเวอร์เตอร์ โดยจำลองเป็นอินเวอร์เตอร์ Huawei ขึ้นมาเอง
รันด้วย:  python test_find_inverter.py

ทำไมต้องมี: ถ้าโครงข้อมูล Modbus ที่ประกอบขึ้นผิดแม้แต่ไบต์เดียว
ตัวค้นหาจะรายงานว่า "ไม่เจอ" ทั้งที่อินเวอร์เตอร์อยู่ตรงนั้น
แล้วจะไล่หาสาเหตุผิดทางกันทั้งวัน
"""

import socket
import struct
import threading
import time

import find_inverter as fi

MODEL = b"SUN2000-30KTL-M3"
SN = b"HV2340123456"
RATED_W = 30000

passed = 0


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ✅ {name}")
    else:
        print(f"  ❌ {name}  {detail}")
        raise SystemExit(1)


def build_registers():
    """จำลองทะเบียนของอินเวอร์เตอร์"""
    regs = {}

    def put_text(start, text, count):
        raw = text.ljust(count * 2, b"\x00")[: count * 2]
        for i in range(count):
            regs[start + i] = (raw[i * 2] << 8) | raw[i * 2 + 1]

    put_text(30000, MODEL, 15)
    put_text(30015, SN, 10)
    regs[30073] = (RATED_W >> 16) & 0xFFFF
    regs[30074] = RATED_W & 0xFFFF
    return regs


class FakeInverter(threading.Thread):
    """เซิร์ฟเวอร์ Modbus TCP ปลอม ตอบเฉพาะ function 3 และเฉพาะ unit id ที่กำหนด"""

    daemon = True

    def __init__(self, accept_unit=1):
        super().__init__()
        self.regs = build_registers()
        self.accept_unit = accept_unit
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.sock.listen(8)

    def run(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()

    def handle(self, conn):
        with conn:
            conn.settimeout(5)
            try:
                req = conn.recv(12)
                if len(req) < 12:
                    return
                tid, _proto, _len, unit, func, addr, qty = struct.unpack(">HHHBBHH", req)

                if unit != self.accept_unit:  # unit ไม่ตรง ตอบ exception เหมือนของจริง
                    conn.sendall(struct.pack(">HHHBBB", tid, 0, 3, unit, func | 0x80, 0x0B))
                    return

                data = b""
                for i in range(qty):
                    data += struct.pack(">H", self.regs.get(addr + i, 0))

                body = struct.pack(">BB", func, len(data)) + data
                conn.sendall(struct.pack(">HHHB", tid, 0, len(body) + 1, unit) + body)
            except Exception:
                pass


print("\nโครงข้อมูล Modbus")

srv = FakeInverter(accept_unit=1)
srv.start()
time.sleep(0.2)
fi.MODBUS_PORT = srv.port  # ให้ตัวค้นหายิงมาที่เซิร์ฟเวอร์ปลอม

raw = fi.modbus_read("127.0.0.1", 30000, 15, unit=1)
check("อ่านทะเบียนแบบข้อความได้", fi.as_text(raw) == MODEL.decode(), f"ได้ {fi.as_text(raw)!r}")

raw = fi.modbus_read("127.0.0.1", 30073, 2, unit=1)
check("อ่านตัวเลข 32 บิตได้", struct.unpack(">i", raw[:4])[0] == RATED_W)

print("\nการระบุตัวตนอุปกรณ์")

info = fi.identify("127.0.0.1")
check("บอกรุ่นได้ถูกต้อง", info["model"] == MODEL.decode(), f"ได้ {info['model']!r}")
check("บอกหมายเลขเครื่องได้", info["sn"] == SN.decode(), f"ได้ {info['sn']!r}")
check("บอกขนาดได้ถูก", info["rated_kw"] == RATED_W / 1000, f"ได้ {info['rated_kw']}")
check("บอก unit id ที่ใช้ได้", info["unit"] == 1)

print("\nกรณี unit id ไม่ใช่ 1")

srv0 = FakeInverter(accept_unit=0)
srv0.start()
time.sleep(0.2)
fi.MODBUS_PORT = srv0.port
info0 = fi.identify("127.0.0.1")
check("ลอง unit 0 ต่อให้เองเมื่อ unit 1 ไม่ตอบ", info0["model"] == MODEL.decode())
check("รายงาน unit id ที่ใช้จริง", info0["unit"] == 0, f"ได้ {info0['unit']}")

print("\nกรณีที่ไม่ใช่อินเวอร์เตอร์")

quiet = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
quiet.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
quiet.bind(("127.0.0.1", 0))
quiet_port = quiet.getsockname()[1]
quiet.listen(4)
fi.MODBUS_PORT = quiet_port
info_q = fi.identify("127.0.0.1")
check("เปิดพอร์ตแต่ไม่ตอบ -> ต้องไม่หลอกว่าเจอ", info_q["model"] is None)

print("\nการเช็คพอร์ต")

fi.MODBUS_PORT = srv.port
check("พอร์ตที่เปิดอยู่ -> True", fi.port_open("127.0.0.1", srv.port) is True)
check("พอร์ตที่ไม่มีอะไร -> False", fi.port_open("127.0.0.1", 9) is False)

print(f"\n{passed} เทสต์ผ่านทั้งหมด ✨\n")
