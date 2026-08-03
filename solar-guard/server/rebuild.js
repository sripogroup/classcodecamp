/**
 * สร้างสถิติของเดือนใหม่จากทุกจุดที่มีอยู่ในฐานข้อมูล
 *
 * ใช้หลังเติมข้อมูลย้อนหลังเข้าไป — ค่าไฟ พีคของเดือน และหน้าต่าง 15 นาที
 * ต้องคิดใหม่ทั้งหมด ไม่ใช่บวกทับของเดิม เพราะข้อมูลที่เพิ่งเติมอยู่ "ตรงกลาง"
 * ของเวลา ไม่ใช่ต่อท้าย การบวกทับจะได้ลำดับเวลาที่ผิดและยอดที่มั่ว
 *
 * แยกออกมาเป็นไฟล์ของตัวเองเพราะทั้งตัวเซิร์ฟเวอร์ (ตอนเติมรูอัตโนมัติทุกเช้า)
 * และสคริปต์ backfill.js (ตอนสั่งเอง) ต้องใช้ตัวเดียวกัน
 */

import { emptyBill, feedBill, billView } from '../src/bill.js';
import { emptyDemand, feedDemand, monthHeadroom, monthKey } from '../src/demand.js';
import { round1, thDateKey } from '../src/util.js';

/**
 * @param store  Store ที่เปิดอยู่
 * @param cfg    config
 * @param nowMs  เวลาที่ใช้ตัดสินว่า "เดือนนี้" และ "วันนี้" คือเมื่อไหร่
 * @returns สรุปตัวเลขที่สร้างใหม่ หรือ null ถ้าไม่มีข้อมูลของเดือนนี้เลย
 */
export function rebuildFromStore(store, cfg, nowMs = Date.now()) {
  const mk = monthKey(nowMs);
  const todayKey = thDateKey(nowMs);

  // ต้นเดือนตามเวลาไทย
  const t = new Date(nowMs + 7 * 3600000);
  const monthStart = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) - 7 * 3600000;

  const rows = store.all(monthStart);
  if (!rows.length) return null;

  let demand = emptyDemand();
  let bill = emptyBill(rows[0].t);
  const mp = { key: mk, gridKw: 0, gridAt: 0, loadKw: 0, loadAt: 0, pvKw: 0, pvAt: 0 };
  let peakToday = { kw: 0, at: 0 };

  for (const r of rows) {
    if (monthKey(r.t) !== mk) continue;
    demand = feedDemand(demand, r.t, r.grid, cfg).demand;
    bill = feedBill(bill, r.t, r.grid, cfg);
    if (r.grid > mp.gridKw) { mp.gridKw = round1(r.grid); mp.gridAt = r.t; }
    if (r.load > mp.loadKw) { mp.loadKw = round1(r.load); mp.loadAt = r.t; }
    if (r.pv > mp.pvKw) { mp.pvKw = round1(r.pv); mp.pvAt = r.t; }
    if (thDateKey(r.t) === todayKey && r.grid > peakToday.kw) peakToday = { kw: round1(r.grid), at: r.t };
  }

  return {
    demand,
    bill,
    monthPeaks: mp,
    peakToday,
    rows: rows.length,
    headroom: monthHeadroom(demand, cfg),
    billMonth: billView(bill, cfg, 'month'),
  };
}

/** เขียนผลที่สร้างใหม่ทับลง state โดยไม่แตะสถานะการเตือน */
export function applyRebuild(store, built) {
  const prev = store.readState() || {};
  store.writeState({
    ...prev,
    demand: built.demand,
    bill: built.bill,
    monthPeaks: built.monthPeaks,
    peakToday: built.peakToday,
  });
}
