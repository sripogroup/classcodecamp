/**
 * อ่านค่าจากอินเวอร์เตอร์ Huawei SUN2000 ผ่าน Modbus TCP
 *
 * ใช้ net socket ของ Node ล้วน ไม่ต้องลง npm เพิ่ม
 * แปลงมาจาก local-reader/ModbusReader.ps1 ที่พิสูจน์กับของจริงแล้ว
 *
 * นิสัยของ SUN2000 ที่ต้องเผื่อไว้ (เจอมากับตัวตอนเขียนตัว PowerShell):
 *   - รับการเชื่อมต่อได้ทีละรายเดียว และไม่ชอบการต่อใหม่ถี่ ๆ
 *   - ต้องรอสัก 2 วินาทีหลังต่อติด ก่อนจะยอมตอบ
 *   - คำสั่งแรกหลังต่อมักถูกทิ้ง จึงต้องยิงทิ้งไปหนึ่งครั้ง
 *
 * เรื่องเครื่องหมาย (สำคัญที่สุด):
 *   รีจิสเตอร์ 37113 ของไซต์นี้เป็น "ลบ" ตอนซื้อไฟเข้า ตรวจเทียบกับพอร์ทัลแล้ว
 *     Modbus -4588 W   ตอนที่พอร์ทัลบอกว่าซื้อไฟ 4.415 kW
 *   จึงต้องคูณ -1 ก่อนใช้ ถ้าใส่ผิดทางระบบจะคิดว่าขายไฟออกตลอดเวลา
 *   แล้วจะไม่เตือนอะไรเลยแม้ไฟหลวงจะพุ่ง
 *
 * อ่านอย่างเดียว: ใช้ function code 0x03 เท่านั้น เขียนรีจิสเตอร์ไม่ได้
 * จึงไปแก้ค่าอะไรในอินเวอร์เตอร์ไม่ได้แม้จะพลาด
 */

import net from 'node:net';

const REG = {
  model: [30000, 15],
  serial: [30015, 10],
  ratedW: [30073, 2],
  pvW: [32080, 2],
  meterStatus: [37100, 1],
  meterW: [37113, 2],
};

export class Inverter {
  constructor({ host = '192.168.1.26', port = 502, unit = 1, meterSign = -1, settleMs = 2000, timeoutMs = 5000 } = {}) {
    Object.assign(this, { host, port, unit, meterSign, settleMs, timeoutMs });
    this.sock = null;
    this.txn = 0;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
  }

  get connected() {
    return !!this.sock && !this.sock.destroyed;
  }

  async connect() {
    this.disconnect();
    await new Promise((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port });
      const fail = (e) => { s.destroy(); reject(e); };
      s.setTimeout(this.timeoutMs, () => fail(new Error('เชื่อมต่อไม่ทันเวลา')));
      s.once('error', fail);
      s.once('connect', () => {
        s.setTimeout(0);
        s.removeListener('error', fail);
        s.on('error', () => this.disconnect());
        s.on('close', () => { this.sock = null; });
        s.on('data', (d) => this._onData(d));
        this.sock = s;
        resolve();
      });
    });

    await sleep(this.settleMs);
    // ยิงทิ้งหนึ่งครั้ง เพราะคำสั่งแรกหลังต่อมักถูกทิ้ง
    try { await this.read(...REG.model); } catch { /* ตั้งใจให้พลาดได้ */ }
  }

  disconnect() {
    if (this.sock) { try { this.sock.destroy(); } catch { /* ปิดไปแล้วก็ไม่เป็นไร */ } }
    this.sock = null;
    this.buf = Buffer.alloc(0);
    if (this.waiter) { this.waiter.reject(new Error('การเชื่อมต่อถูกปิด')); this.waiter = null; }
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.waiter) { this.buf = Buffer.alloc(0); return; } // ของค้างจากคำสั่งเก่า ทิ้ง
    if (this.buf.length < 9) return;

    const w = this.waiter;
    if (this.buf[7] & 0x80) {
      this.waiter = null;
      const code = this.buf[8];
      this.buf = Buffer.alloc(0);
      return w.reject(new Error(`อินเวอร์เตอร์ปฏิเสธคำสั่ง (exception ${code})`));
    }
    const byteCount = this.buf[8];
    if (this.buf.length < 9 + byteCount) return;

    const data = this.buf.subarray(9, 9 + byteCount);
    this.buf = this.buf.subarray(9 + byteCount);
    this.waiter = null;
    w.resolve(Buffer.from(data));
  }

  read(addr, count) {
    if (!this.connected) return Promise.reject(new Error('ยังไม่ได้เชื่อมต่อ'));
    if (this.waiter) return Promise.reject(new Error('มีคำสั่งค้างอยู่'));

    this.txn = (this.txn + 1) & 0xffff;
    const req = Buffer.alloc(12);
    req.writeUInt16BE(this.txn, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(6, 4);
    req.writeUInt8(this.unit, 6);
    req.writeUInt8(0x03, 7);
    req.writeUInt16BE(addr, 8);
    req.writeUInt16BE(count, 10);

    this.buf = Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`อ่านรีจิสเตอร์ ${addr} ไม่ทันเวลา`));
      }, this.timeoutMs);
      this.waiter = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.sock.write(req);
    });
  }

  /** ค่าที่ต้องใช้จริงหนึ่งชุด หน่วย kW และ grid เป็นบวก = ซื้อไฟเข้า */
  async readNow() {
    const pvRaw = int32(await this.read(...REG.pvW));
    const meterRaw = int32(await this.read(...REG.meterW));
    const pv = round3(pvRaw / 1000);
    const grid = round3((this.meterSign * meterRaw) / 1000);
    return { pv, grid, load: round3(pv + grid), pvRaw, meterRaw };
  }

  /** ข้อมูลประจำเครื่อง อ่านครั้งเดียวตอนเริ่ม */
  async identify() {
    return {
      model: text(await this.read(...REG.model)),
      serial: text(await this.read(...REG.serial)),
      ratedW: int32(await this.read(...REG.ratedW)),
      meterOnline: int16(await this.read(...REG.meterStatus)) === 1,
    };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round3 = (n) => Math.round(n * 1000) / 1000;

function int32(b) {
  const v = b.readUInt32BE(0);
  return v >= 2147483648 ? v - 4294967296 : v;
}
function int16(b) {
  const v = b.readUInt16BE(0);
  return v >= 32768 ? v - 65536 : v;
}
function text(b) {
  const s = b.toString('ascii');
  const z = s.indexOf('\0');
  return (z >= 0 ? s.slice(0, z) : s).trim();
}
