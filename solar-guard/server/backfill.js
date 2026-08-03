/**
 * เติมประวัติเข้าฐานข้อมูลบนเครื่อง จากไฟล์ CSV ที่ตัวอ่านบันทึกไว้
 *
 *   node server/backfill.js <ไฟล์.csv> [<ไฟล์.csv> ...]
 *
 * ใช้ตอนย้ายจากคลาวด์มาเครื่องนี้ครั้งแรก และตอนที่ต้องกู้สถิติกลับมาหลังมีอะไรพัง
 *
 * สร้างใหม่จากศูนย์ทุกครั้ง ไม่ใช่บวกทับของเดิม จึงรันซ้ำได้โดยยอดไม่บวม
 * และ **ไม่ส่งข้อความหาใครทั้งสิ้น** — การเล่นประวัติย้อนหลังผ่านทางเดินปกติ
 * จะทำให้พนักงานได้ข้อความ "ต้องลดโหลด" ของเหตุการณ์ที่ผ่านไปแล้วสองวัน
 */

import { readFileSync, existsSync } from 'node:fs';
import { emptyState } from '../src/analyze.js';
import { emptyBill, feedBill, billView } from '../src/bill.js';
import { emptyDemand, feedDemand, monthHeadroom, monthKey } from '../src/demand.js';
import { round1, thDateKey } from '../src/util.js';
import { loadLocalConfig } from './config-local.js';
import { Store } from './store.js';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('ต้องระบุไฟล์ CSV อย่างน้อยหนึ่งไฟล์');
  process.exit(1);
}

const cfg = loadLocalConfig();
const store = new Store(cfg.local.dbFile);

/** CSV รูปแบบ: timestamp,pv_kw,grid_kw,load_kw — เวลาเป็นเวลาไทย */
function readCsv(file) {
  if (!existsSync(file)) { console.error(`ไม่พบไฟล์: ${file}`); return []; }
  const rows = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const m = p[0].trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (!m) continue;
    // เวลาในไฟล์เป็นเวลาไทย (UTC+7) แปลงเป็น epoch โดยลบ 7 ชั่วโมง
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +m[6]);
    const pv = Number(p[1]); const grid = Number(p[2]); const load = Number(p[3]);
    if (![pv, grid, load].every(Number.isFinite)) continue;
    // ทิ้งค่าที่เป็นไปไม่ได้ ไม่งั้นจะลอกความเสียหายเดิมกลับเข้ามาอีกรอบ
    if (Math.max(Math.abs(pv), Math.abs(grid), Math.abs(load)) > cfg.maxPlausibleKw) continue;
    rows.push({ t, pv, grid, load });
  }
  return rows;
}

const all = files.flatMap(readCsv);
if (!all.length) { console.error('ไม่มีแถวไหนใช้ได้เลย'); process.exit(1); }

// เรียงตามเวลา และตัดจุดที่เวลาซ้ำกัน (ไฟล์สองไฟล์อาจคาบเกี่ยวกัน)
all.sort((a, b) => a.t - b.t);
const rows = all.filter((r, i) => i === 0 || r.t !== all[i - 1].t);

const nowMonth = monthKey(rows[rows.length - 1].t);
let demand = emptyDemand();
let bill = emptyBill(rows[0].t);
const mp = { key: nowMonth, gridKw: 0, gridAt: 0, loadKw: 0, loadAt: 0, pvKw: 0, pvAt: 0 };
let peakToday = { kw: 0, at: 0 };
const todayKey = thDateKey(rows[rows.length - 1].t);

for (const r of rows) {
  store.addReading(r.t, r.pv, r.grid, r.load);
  if (monthKey(r.t) !== nowMonth) continue;   // สถิติของเดือนก่อนไม่เอามาปน

  demand = feedDemand(demand, r.t, r.grid, cfg).demand;
  bill = feedBill(bill, r.t, r.grid, cfg);
  if (r.grid > mp.gridKw) { mp.gridKw = round1(r.grid); mp.gridAt = r.t; }
  if (r.load > mp.loadKw) { mp.loadKw = round1(r.load); mp.loadAt = r.t; }
  if (r.pv > mp.pvKw) { mp.pvKw = round1(r.pv); mp.pvAt = r.t; }
  if (thDateKey(r.t) === todayKey && r.grid > peakToday.kw) peakToday = { kw: round1(r.grid), at: r.t };
}

// เก็บตัวอย่างล่าสุดไว้ใน state ด้วย เพราะ viewState ใช้ตัวนี้ตัดสินว่าข้อมูลสดไหม
const tail = rows.slice(-800).map((r) => ({ t: r.t, pv: round1(r.pv), grid: round1(r.grid), load: round1(r.load), bat: 0 }));

const prev = store.readState() || emptyState();
store.writeState({ ...prev, demand, bill, monthPeaks: mp, peakToday, samples: tail, lastOkAt: rows[rows.length - 1].t });

const h = monthHeadroom(demand, cfg);
const b = billView(bill, cfg, 'month');
const fmt = (ts) => new Date(ts + 7 * 3600000).toISOString().replace('T', ' ').slice(0, 16);

console.log(`อ่านมา ${rows.length} จุด  ตั้งแต่ ${fmt(rows[0].t)} ถึง ${fmt(rows[rows.length - 1].t)} (เวลาไทย)`);
console.log(`พีคเฉลี่ย 15 นาทีของเดือน : ${h.peakKw.toFixed(1)} kW / เพดาน ${h.limitKw} kW  เหลือ ${h.headroomKw.toFixed(1)} kW`);
console.log(`สูงสุดของเดือน            : ไฟหลวง ${mp.gridKw} kW · โหลด ${mp.loadKw} kW · โซลาร์ ${mp.pvKw} kW`);
console.log(`พีควันนี้                 : ${peakToday.kw} kW`);
console.log(`ค่าไฟเดือนนี้             : ${b.totalBaht.toLocaleString('th-TH')} บาท (${b.totalKwh} kWh, demand ${b.demandKw} kW)`);
console.log(`ฐานข้อมูล                 : ${JSON.stringify(store.stats())}`);
store.close();
