/**
 * ทดสอบการคิดค่าไฟตามโครงสร้างบิล PEA
 * รันด้วย:  node test/bill.test.js
 *
 * เทสต์ที่สำคัญที่สุดในไฟล์นี้คือ "ตรงกับบิลจริงใบ 07/2569" — ถ้าข้อนั้นพัง
 * แปลว่าสูตรคิดเงินผิด และตัวเลขทุกตัวบนหน้าจอเชื่อไม่ได้
 */

import assert from 'node:assert';
import { billView, emptyBill, feedBill } from '../src/bill.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({});

const MIN = 60000;
// 2026-08-03 10:00 น. เวลาไทย = 03:00 UTC — วันจันทร์ อยู่ในช่วง on-peak (จ-ศ 09:00-22:00)
const ONPEAK = Date.parse('2026-08-03T03:00:00Z');
// 2026-08-03 23:00 น. เวลาไทย = 16:00 UTC — เลย 22:00 แล้ว เป็น off-peak
const OFFPEAK = Date.parse('2026-08-03T16:00:00Z');
// 2026-08-02 10:00 น. เวลาไทย = วันอาทิตย์ — off-peak ทั้งวัน
const SUNDAY = Date.parse('2026-08-02T03:00:00Z');

let pass = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

/** ป้อนค่าเป็นชุด: [[นาทีจาก start, kW], ...] */
function run(series, start, b) {
  let bill = b || emptyBill(start);
  for (const [min, kw] of series) bill = feedBill(bill, start + min * MIN, kw, cfg);
  return bill;
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ได้ ${a} ควรใกล้ ${b} (±${tol})`);

console.log('\nคิดค่าไฟตามโครงสร้างบิล PEA\n');

test('ตรงกับบิลจริงใบ 07/2569 ทุกบรรทัด', () => {
  // ป้อนตัวเลขจากบิลจริงเข้าไปตรง ๆ แล้วดูว่าคิดเงินออกมาได้เท่ากันไหม
  const b = emptyBill(ONPEAK);
  b.month.onPeakKwh = 1703.91;
  b.month.offPeakKwh = 1014.9;
  b.month.demandKw = 25.09;

  const v = billView(b, cfg, 'month');
  near(v.energyOnBaht, 7128.99, 0.02, 'ค่าพลังงาน Peak');
  near(v.energyOffBaht, 2642.5, 0.02, 'ค่าพลังงาน Off Peak');
  near(v.demandBaht, 3335.21, 0.02, 'ค่าความต้องการพลังไฟฟ้า');
  near(v.serviceBaht, 312.24, 0.01, 'ค่าบริการ');
  near(v.ftBaht, 441.26, 0.02, 'ค่า Ft');
  near(v.vatBaht, 970.21, 0.05, 'VAT');
  near(v.totalBaht, 14830.41, 0.1, 'รวมสุทธิ');
});

test('ค่า demand คิดเฉพาะช่วง on-peak — พีคตอนดึกต้องไม่ถูกคิดเงิน', () => {
  // ดึงไฟ 40 kW ค้างไว้ครึ่งชั่วโมงตอนห้าทุ่ม ซึ่งเป็น off-peak
  const b = run([[0, 40], [5, 40], [10, 40], [15, 40], [20, 40], [25, 40], [30, 40]], OFFPEAK);
  const v = billView(b, cfg, 'month');
  assert.strictEqual(v.demandKw, 0, 'พีคตอน off-peak ต้องไม่ถูกเก็บเป็นค่า demand');
  assert.strictEqual(v.demandBaht, 0, 'ค่า demand ต้องเป็นศูนย์');
  assert.ok(v.offPeakKwh > 15, 'แต่พลังงานต้องยังถูกนับเข้าถัง off-peak');
  assert.strictEqual(v.onPeakKwh, 0, 'และต้องไม่หลุดไปเข้าถัง on-peak');
});

test('วันอาทิตย์เป็น off-peak ทั้งวัน', () => {
  const b = run([[0, 20], [10, 20], [20, 20]], SUNDAY);
  const v = billView(b, cfg, 'month');
  assert.strictEqual(v.onPeakKwh, 0, 'วันอาทิตย์ต้องไม่มี on-peak');
  assert.ok(v.offPeakKwh > 6, 'ต้องเข้าถัง off-peak');
  assert.strictEqual(v.demandKw, 0, 'และไม่คิดค่า demand');
});

test('พีคตอน on-peak ถูกเก็บเป็นค่าเฉลี่ย 15 นาที ไม่ใช่ค่าสูงสุด ณ ขณะนั้น', () => {
  // หน้าต่างแรกเต็ม 15 นาที: 20 kW ตลอด -> เฉลี่ย 20
  // หน้าต่างที่สอง: พุ่งไป 60 kW แค่ 3 นาทีแล้วกลับมา 10 -> เฉลี่ยต้องต่ำกว่า 60 มาก
  const series = [];
  for (let m = 0; m <= 15; m += 3) series.push([m, 20]);
  series.push([18, 60], [21, 10], [24, 10], [27, 10], [30, 10], [33, 10]);
  const b = run(series, ONPEAK);
  const v = billView(b, cfg, 'month');
  near(v.demandKw, 20, 1.5, 'ค่า demand ควรอยู่แถว 20 ไม่ใช่ 60');
  assert.ok(v.demandKw < 40, 'ค่าพุ่งแวบเดียวต้องไม่ถูกคิดเป็นพีคเต็ม ๆ');
});

test('ข้อมูลขาดช่วงยาว -> ไม่เดามั่ว และบันทึกไว้ว่าขาดไปกี่นาที', () => {
  // อ่านได้ 20 kW แล้วเงียบไป 4 ชั่วโมง (เครื่องอ่านปิด) แล้วกลับมา
  const b = run([[0, 20], [5, 20], [245, 20], [250, 20]], ONPEAK);
  const v = billView(b, cfg, 'month');
  assert.ok(v.missedMin >= 235, `ต้องบันทึกช่วงที่ขาดไว้ ได้ ${v.missedMin} นาที`);
  // 4 ชั่วโมงที่ 20 kW = 80 kWh ถ้าเดาไปด้วยจะเกิน 80 แน่นอน
  assert.ok(v.totalKwh < 10, `ต้องไม่เดาพลังงานช่วงที่ไม่มีข้อมูล ได้ ${v.totalKwh} kWh`);
});

test('ข้ามวันแล้วยอดของวันต้องรีเซ็ต แต่ยอดของเดือนต้องสะสมต่อ', () => {
  // 2026-08-03 21:00 -> 2026-08-04 09:30 (ข้ามวันไทย)
  const t1 = Date.parse('2026-08-03T14:00:00Z');
  const t2 = Date.parse('2026-08-04T02:30:00Z');
  let b = run([[0, 30], [5, 30], [10, 30]], t1);
  const dayBefore = billView(b, cfg, 'day').totalKwh;
  const monthBefore = billView(b, cfg, 'month').totalKwh;
  assert.ok(dayBefore > 0, 'วันแรกต้องมียอด');

  b = run([[0, 12], [5, 12]], t2, b);
  const day = billView(b, cfg, 'day');
  const month = billView(b, cfg, 'month');
  assert.ok(day.totalKwh < dayBefore, 'ยอดของวันต้องรีเซ็ตเมื่อข้ามวัน');
  assert.ok(month.totalKwh > monthBefore, 'ยอดของเดือนต้องสะสมต่อ ไม่รีเซ็ตตามวัน');
});

test('ข้ามเดือนแล้วต้องล้างทุกถังรวมทั้งพีค', () => {
  const jul = Date.parse('2026-07-31T14:00:00Z'); // 31 ก.ค. 21:00
  const aug = Date.parse('2026-08-01T03:00:00Z'); // 1 ส.ค. 10:00
  let b = run([[0, 30], [5, 30], [10, 30]], jul);
  b.month.demandKw = 25; // สมมติว่าเดือนก่อนเคยพีคไว้
  b = feedBill(b, aug, 5, cfg);
  const v = billView(b, cfg, 'month');
  assert.strictEqual(v.demandKw, 0, 'พีคของเดือนก่อนต้องไม่ติดมาเดือนใหม่');
  assert.strictEqual(v.totalKwh, 0, 'พลังงานของเดือนก่อนต้องไม่ติดมาด้วย');
});

test('ยอดของวันต้องไม่มีค่า demand กับค่าบริการ (เป็นรายการรายเดือน)', () => {
  const b = run([[0, 25], [5, 25], [10, 25], [15, 25], [20, 25]], ONPEAK);
  const day = billView(b, cfg, 'day');
  assert.strictEqual(day.demandBaht, 0, 'ยอดรายวันต้องไม่มีค่า demand');
  assert.strictEqual(day.serviceBaht, 0, 'ยอดรายวันต้องไม่มีค่าบริการ');
  assert.ok(day.totalBaht > 0, 'แต่ต้องมีค่าพลังงาน');
});

test('ขายไฟออก (ค่าติดลบ) ต้องนับเป็นศูนย์ ไม่ใช่ลบยอดทิ้ง', () => {
  const b = run([[0, -5], [5, -5], [10, -5]], ONPEAK);
  const v = billView(b, cfg, 'month');
  assert.strictEqual(v.totalKwh, 0, 'ค่าติดลบต้องไม่ทำให้ยอดติดลบ');
  assert.strictEqual(v.totalBaht > 0, true, 'แต่ยังมีค่าบริการรายเดือนอยู่');
});

test('ยิงข้อมูลซ้ำเวลาเดิมหรือย้อนเวลา ต้องไม่บวกยอดซ้ำ', () => {
  const b = run([[0, 20], [5, 20]], ONPEAK);
  const before = billView(b, cfg, 'month').totalKwh;
  const b2 = feedBill(feedBill(b, ONPEAK + 5 * MIN, 20, cfg), ONPEAK + 1 * MIN, 20, cfg);
  near(billView(b2, cfg, 'month').totalKwh, before, 0.001, 'ยอดต้องไม่ขยับ');
});

test('บอกได้ว่ากดพีคลง 1 kW ประหยัดกี่บาท (รวม VAT)', () => {
  const v = billView(emptyBill(ONPEAK), cfg, 'month');
  near(v.perKwBaht, 132.93 * 1.07, 0.01, 'ค่าประหยัดต่อ 1 kW');
});

console.log(`\n${pass} เทสต์ผ่าน ทั้งหมด ✨\n`);
