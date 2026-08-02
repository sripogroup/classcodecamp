/**
 * ทดสอบการคิดค่า demand 15 นาที และการตัดโหลดอัตโนมัติ
 * รันด้วย:  node test/demand.test.js
 *
 * ส่วนนี้สำคัญที่สุดในโปรเจกต์ — คิดผิด = โดนค่าไฟแพงทั้งปี
 */

import assert from 'node:assert';
import { loadConfig } from '../src/config.js';
import { emptyDemand, feedDemand, monthHeadroom, windowStart, WINDOW_H } from '../src/demand.js';
import { decideShed, emptyShedState } from '../src/autoshed.js';
import { evaluateDemand, emptyState } from '../src/analyze.js';

const cfg = loadConfig({
  DEMAND_LIMIT_KW: '30',
  DEMAND_TARGET_KW: '27',
  DEMAND_ACTION_KW: '24',
  DEMAND_RESTORE_KW: '18',
  SHED_MARGIN_KW: '2',
  AUTOSHED_MODE: 'on',
  AUTOSHED_MIN_OFF_MIN: '10',
  AUTOSHED_MIN_ON_MIN: '15',
  AUTOSHED_MAX_OFF_MIN: '30',
  AUTOSHED_MAX_ZONES: '3',
  AUTOSHED_RESTORE_GAP_MIN: '3',
  ZONES: JSON.stringify([
    { id: 'ac1', name: 'แอร์ออฟฟิศชั้น 2', kw: 12, priority: 1 },
    { id: 'ac2', name: 'แอร์ห้องประชุม', kw: 6, priority: 2 },
    { id: 'pump', name: 'ปั๊มน้ำสำรอง', kw: 7, priority: 3 },
    { id: 'server', name: 'แอร์ห้องเซิร์ฟเวอร์', kw: 4, priority: 9, protected: true },
  ]),
});

const MIN = 60000;
// 2026-08-03 13:00:00 น. เวลาไทย = 06:00 UTC — ตรงขอบหน้าต่าง 15 นาทีพอดี
const W0 = Date.parse('2026-08-03T06:00:00Z');

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

/** ป้อนค่าเป็นชุด: [[นาทีจาก W0, kW], ...] */
function run(series, start = W0, d = emptyDemand()) {
  let demand = d;
  let last = null;
  const closed = [];
  for (const [min, kw] of series) {
    last = feedDemand(demand, start + min * MIN, kw, cfg);
    demand = last.demand;
    closed.push(...last.closed);
  }
  return { demand, window: last.window, closed };
}

console.log('\nหน้าต่าง 15 นาที');

test('ขอบหน้าต่างอิงหน้าปัดนาฬิกา (0,15,30,45)', () => {
  const t = Date.parse('2026-08-03T06:07:33Z');
  assert.equal(windowStart(t), Date.parse('2026-08-03T06:00:00Z'));
  assert.equal(windowStart(Date.parse('2026-08-03T06:44:59Z')), Date.parse('2026-08-03T06:30:00Z'));
});

test('ใช้ไฟคงที่ 20 kW ตลอดหน้าต่าง -> ค่าเฉลี่ยได้ 20 kW', () => {
  const { closed } = run([[0, 20], [5, 20], [10, 20], [15, 20]]);
  assert.equal(closed.length, 1);
  assert.ok(Math.abs(closed[0].avgKw - 20) < 0.01, `ได้ ${closed[0].avgKw}`);
});

test('ไฟพุ่งแวบเดียว 60 kW 1 นาที -> เฉลี่ยแล้วแทบไม่ขยับ (นี่คือเหตุผลที่ต้องคิดแบบ 15 นาที)', () => {
  const series = [[0, 0], [1, 60], [2, 0]];
  for (let m = 3; m <= 15; m++) series.push([m, 0]);
  const { closed } = run(series);
  assert.equal(closed.length, 1);
  assert.ok(closed[0].avgKw < 6, `ได้ ${closed[0].avgKw} kW ควรน้อยกว่า 6`);
});

test('ใช้ไฟ 30 kW ครึ่งหน้าต่าง แล้วหยุด -> เฉลี่ยประมาณ 15 kW', () => {
  const { closed } = run([[0, 30], [7.5, 30], [7.6, 0], [15, 0]]);
  assert.ok(Math.abs(closed[0].avgKw - 15) < 1.5, `ได้ ${closed[0].avgKw}`);
});

test('พลังงานสะสมข้ามขอบหน้าต่างต้องถูกตัดแบ่งให้ถูก', () => {
  // 20 kW ตั้งแต่นาทีที่ 13 ถึง 18 -> หน้าต่างแรกได้ 2 นาที หน้าต่างสองได้ 3 นาที
  const { closed, demand } = run([[0, 0], [13, 0], [13.01, 20], [18, 20]]);
  assert.equal(closed.length, 1, 'ต้องปิดไป 1 หน้าต่าง');
  // หน้าต่างแรก: 20 kW ประมาณ 2 นาที = 0.667 kWh -> เฉลี่ย 2.7 kW
  assert.ok(closed[0].avgKw > 1.5 && closed[0].avgKw < 4, `หน้าต่างแรกได้ ${closed[0].avgKw}`);
  // หน้าต่างที่สองสะสมอยู่ประมาณ 3 นาที x 20 kW = 1 kWh
  assert.ok(Math.abs(demand.energyKwh - 1) < 0.2, `สะสม ${demand.energyKwh} kWh`);
});

console.log('\nการพยากรณ์ภายในหน้าต่าง');

test('เพิ่งเริ่มหน้าต่าง ใช้ 28 kW -> คาดว่าจะจบที่ 28 kW', () => {
  const { window } = run([[0, 28], [1, 28]]);
  assert.ok(Math.abs(window.projectedKw - 28) < 1, `ได้ ${window.projectedKw}`);
  assert.equal(window.remainMin, 14);
});

test('ครึ่งแรกใช้หนัก ครึ่งหลังต้องเบาลงเท่าไหร่ ระบบต้องบอกได้', () => {
  // 7.5 นาทีแรกที่ 40 kW = 5 kWh ; งบทั้งหน้าต่างที่เป้า 27 kW = 6.75 kWh
  // เหลือ 1.75 kWh ใน 7.5 นาที (0.125 ชม.) = ใช้ได้เฉลี่ย 14 kW
  const { window } = run([[0, 40], [7.5, 40]]);
  assert.ok(Math.abs(window.allowedRestKw - 14) < 2, `ได้ ${window.allowedRestKw} ควรใกล้ 14`);
});

test('ถ้าหน้าต่างเสียไปแล้ว ต้องบอกว่า blown (ปิดทุกอย่างก็ไม่ทัน)', () => {
  // 12 นาทีแรกที่ 40 kW = 8 kWh > งบ 6.75 kWh แล้ว
  const { window } = run([[0, 40], [12, 40]]);
  assert.equal(window.blown, true);
  assert.ok(window.allowedRestKw < 0);
});

console.log('\nพีคของเดือน');

test('พีคของเดือนนับจากหน้าต่างที่ปิดแล้วเท่านั้น', () => {
  const { demand } = run([[0, 25], [15, 25], [30, 10], [45, 10]]);
  const h = monthHeadroom(demand, cfg);
  assert.ok(Math.abs(h.peakKw - 25) < 0.5, `พีคได้ ${h.peakKw}`);
  assert.ok(Math.abs(h.headroomKw - 5) < 0.5, `เหลือระยะ ${h.headroomKw}`);
  assert.equal(h.breached, false);
});

test('แตะ 30 kW = breached', () => {
  const { demand } = run([[0, 31], [15, 31]]);
  const h = monthHeadroom(demand, cfg);
  assert.equal(h.breached, true);
  assert.ok(h.headroomKw <= 0);
});

test('ขึ้นเดือนใหม่ พีคต้องรีเซ็ต', () => {
  const aug = run([[0, 28], [15, 28]]);
  assert.ok(monthHeadroom(aug.demand, cfg).peakKw > 27);
  const sep = run([[0, 5], [15, 5]], Date.parse('2026-09-01T06:00:00Z'), aug.demand);
  assert.ok(monthHeadroom(sep.demand, cfg).peakKw < 6, 'พีคต้องเริ่มนับใหม่');
});

test('ข้อมูลขาดหายไปนาน ต้องเริ่มหน้าต่างใหม่ ไม่เดาพลังงานที่หายไป', () => {
  const a = run([[0, 20], [5, 20]]);
  const b = feedDemand(a.demand, W0 + 90 * MIN, 20, cfg); // เงียบไป 85 นาที
  assert.ok(b.window.energyKwh < 1, 'ต้องไม่ลากพลังงานข้ามช่องว่างยาว ๆ');
});

console.log('\nการเตือนเรื่องเพดาน');

test('คาดว่าจะเกิน 24 kW -> เตือนทันที ไม่รอ 10 นาที', () => {
  const { window, demand, closed } = run([[0, 26], [1, 26]]);
  const res = evaluateDemand(emptyState(), { window, headroom: monthHeadroom(demand, cfg), closed, sample: { grid: 26, pv: 0, load: 26 } }, cfg, W0 + MIN);
  assert.equal(res.events.filter((e) => e.type === 'demand_risk').length, 1);
});

test('เดือนนี้เกินไปแล้ว -> แจ้งครั้งเดียว ไม่ตื่นตระหนกซ้ำ', () => {
  const { window, demand, closed } = run([[0, 31], [15, 31], [16, 31]]);
  const h = monthHeadroom(demand, cfg);
  const first = evaluateDemand(emptyState(), { window, headroom: h, closed, sample: { grid: 31, pv: 0, load: 31 } }, cfg, W0 + 16 * MIN);
  assert.equal(first.events.filter((e) => e.type === 'demand_breached').length, 1);
  const second = evaluateDemand(first.state, { window, headroom: h, closed: [], sample: { grid: 31, pv: 0, load: 31 } }, cfg, W0 + 21 * MIN);
  assert.equal(second.events.length, 0, 'ครั้งที่สองต้องเงียบ');
});

console.log('\nตัดโหลดอัตโนมัติ');

const ctxAt = (powerNow, projectedKw, allowedRestKw, remainMin = 10) => ({
  powerNow,
  projectedKw,
  allowedRestKw,
  remainMin,
  monthPeakKw: 20,
});

test('โหมด off ต้องไม่สั่งอะไรเลย', () => {
  const offCfg = { ...cfg, autoshedMode: 'off' };
  const res = decideShed(emptyShedState(), ctxAt(35, 33, 5), offCfg, W0);
  assert.equal(res.actions.length, 0);
});

test('ไฟจะเกินเป้า -> ตัดโหลดให้พอ', () => {
  const res = decideShed(emptyShedState(), ctxAt(35, 33, 20), cfg, W0);
  const off = res.actions.filter((a) => a.to === 'off');
  assert.ok(off.length >= 1, 'ต้องมีการสั่งปิด');
  const cut = off.reduce((a, x) => a + x.kw, 0);
  assert.ok(cut >= res.needKw - 7, `ตัดได้ ${cut} kW จากที่ต้องการ ${res.needKw}`);
});

test('ห้ามแตะโซนที่ protected ไม่ว่าจะหนักแค่ไหน', () => {
  const res = decideShed(emptyShedState(), ctxAt(60, 60, 1), cfg, W0);
  assert.ok(!res.actions.some((a) => a.id === 'server'), 'ห้ามปิดแอร์ห้องเซิร์ฟเวอร์');
});

test('ปิดโซนที่กระทบน้อยก่อน (priority ต่ำก่อน)', () => {
  const res = decideShed(emptyShedState(), ctxAt(30, 29, 20), cfg, W0);
  const firstOff = res.actions.find((a) => a.to === 'off');
  assert.equal(firstOff.id, 'ac1', `ปิด ${firstOff.id} ก่อน ควรเป็น ac1`);
});

test('ปิดพร้อมกันได้ไม่เกิน AUTOSHED_MAX_ZONES', () => {
  const res = decideShed(emptyShedState(), ctxAt(90, 90, 1), cfg, W0);
  assert.ok(res.actions.filter((a) => a.to === 'off').length <= 3);
});

test('เพิ่งปิดไป ยังไม่ครบเวลาขั้นต่ำ ห้ามเปิดกลับ (กันคอมเพรสเซอร์พัง)', () => {
  const first = decideShed(emptyShedState(), ctxAt(35, 33, 20), cfg, W0);
  const later = decideShed(first.shedState, ctxAt(8, 8, 40), cfg, W0 + 5 * MIN); // ปลอดภัยแล้วแต่เพิ่งผ่าน 5 นาที
  assert.equal(later.actions.filter((a) => a.to === 'on').length, 0);
});

test('ครบเวลาขั้นต่ำและไฟลงมาแล้ว -> เปิดกลับทีละโซน', () => {
  const first = decideShed(emptyShedState(), ctxAt(40, 40, 5), cfg, W0);
  const offCount = first.actions.filter((a) => a.to === 'off').length;
  assert.ok(offCount >= 2, 'ต้องปิดหลายโซนก่อน');
  const later = decideShed(first.shedState, ctxAt(8, 8, 40), cfg, W0 + 12 * MIN);
  assert.equal(later.actions.filter((a) => a.to === 'on').length, 1, 'เปิดกลับได้ทีละ 1 โซนเท่านั้น');
});

test('ไฟยังไม่ลงมาถึงเกณฑ์เปิดกลับ ต้องยังไม่เปิด', () => {
  const first = decideShed(emptyShedState(), ctxAt(40, 40, 5), cfg, W0);
  const later = decideShed(first.shedState, ctxAt(22, 22, 22), cfg, W0 + 20 * MIN); // 22 > เกณฑ์เปิดกลับ 18
  assert.equal(later.actions.filter((a) => a.to === 'on').length, 0);
});

test('ปิดนานเกิน MAX_OFF -> หมุนเวียนไปโซนอื่น คนจะได้ไม่ร้อนอยู่โซนเดียว', () => {
  const first = decideShed(emptyShedState(), ctxAt(35, 33, 20), cfg, W0);
  const rotated = decideShed(first.shedState, ctxAt(35, 33, 20), cfg, W0 + 35 * MIN);
  assert.ok(rotated.actions.some((a) => a.to === 'on'), 'ต้องมีการเปิดคืนโซนที่ปิดนานแล้ว');
  assert.ok(rotated.actions.some((a) => a.to === 'off'), 'และต้องปิดโซนอื่นแทน');
});

test('เพิ่งเปิดกลับ ห้ามสั่งปิดซ้ำทันที', () => {
  const shed = {
    ...emptyShedState(),
    zones: { ac1: { off: false, changedAt: W0, reason: 'เพิ่งเปิด', count: 1 } },
  };
  const res = decideShed(shed, ctxAt(35, 33, 20), cfg, W0 + 5 * MIN);
  assert.ok(!res.actions.some((a) => a.id === 'ac1' && a.to === 'off'), 'ac1 เพิ่งเปิดกลับ 5 นาที ยังปิดไม่ได้');
});

test('ไฟปกติ ไม่มีอะไรถูกปิด -> ไม่ต้องทำอะไร', () => {
  const res = decideShed(emptyShedState(), ctxAt(10, 11, 40), cfg, W0);
  assert.equal(res.actions.length, 0);
  assert.equal(res.needKw, 0);
});

console.log('\nการถอยของระบบตัดโหลด');

test('เดือนนี้เกินเพดานไปแล้ว -> ห้ามตัดโหลดต่อ และต้องทยอยเปิดกลับ', () => {
  const first = decideShed(emptyShedState(), ctxAt(40, 40, 5), cfg, W0);
  assert.ok(first.actions.some((a) => a.to === 'off'), 'รอบแรกต้องมีการปิด');
  // เดือนนี้ชนเพดานไปแล้ว ตัดต่อไม่ช่วยอะไร ปล่อยให้คนใช้แอร์ได้
  const after = decideShed(first.shedState, { ...ctxAt(40, 40, 5), breached: true }, cfg, W0 + 12 * MIN);
  assert.equal(after.actions.filter((a) => a.to === 'off').length, 0, 'ห้ามปิดเพิ่ม');
  assert.equal(after.actions.filter((a) => a.to === 'on').length, 1, 'ต้องเริ่มเปิดกลับ');
});

test('คนกด /restore แล้ว ระบบห้ามสั่งปิดซ้ำระหว่างที่พักอยู่', () => {
  const res = decideShed(emptyShedState(), { ...ctxAt(45, 45, 2), paused: true }, cfg, W0);
  assert.equal(res.actions.filter((a) => a.to === 'off').length, 0);
  assert.equal(res.needKw, 0);
});

test('ถึงจะถอย ก็ยังต้องกันคอมเพรสเซอร์ (ไม่เปิดกลับก่อนครบ MIN_OFF)', () => {
  const first = decideShed(emptyShedState(), ctxAt(40, 40, 5), cfg, W0);
  const after = decideShed(first.shedState, { ...ctxAt(40, 40, 5), breached: true }, cfg, W0 + 3 * MIN);
  assert.equal(after.actions.length, 0, 'เพิ่งปิดไป 3 นาที ยังเปิดกลับไม่ได้');
});

console.log('\n/mute ต้องไม่ปิดปากการเตือนเพดาน');

test('กด /mute ไว้ แต่ใกล้ชนเพดาน -> ยังต้องเตือน', () => {
  const { window, demand, closed } = run([[0, 28], [1, 28]]);
  const muted = { ...emptyState(), mutedUntil: W0 + 60 * MIN };
  const res = evaluateDemand(muted, { window, headroom: monthHeadroom(demand, cfg), closed, sample: { grid: 28, pv: 0, load: 28 } }, cfg, W0 + MIN);
  assert.equal(res.events.filter((e) => e.type === 'demand_risk').length, 1, 'mute ต้องไม่กลบเรื่องเพดาน');
});

console.log(`\n${pass} เทสต์ผ่าน${process.exitCode ? ' (มีบางข้อไม่ผ่าน)' : ' ทั้งหมด ✨'}\n`);
