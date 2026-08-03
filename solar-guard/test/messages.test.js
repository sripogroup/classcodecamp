/**
 * ทดสอบว่าข้อความทุกแบบสร้างได้จริงและมีเนื้อหาที่ต้องมีครบ
 * รันด้วย:  node test/messages.test.js
 *
 * เหตุผลที่ต้องมีเทสต์นี้: ข้อความบางแบบเกิดขึ้นปีละครั้ง (เช่น พีคเกิน 30 kW)
 * ถ้ามันพังตอนนั้นพอดี เราจะไม่มีทางรู้ล่วงหน้าเลย
 */

import assert from 'node:assert';
import { loadConfig } from '../src/config.js';
import { buildDailySummary, buildMessage } from '../src/messages.js';
import { emptyDemand, feedDemand, monthHeadroom } from '../src/demand.js';
import { emptyState, evaluate } from '../src/analyze.js';

const cfg = loadConfig({ SITE_NAME: 'โรงงานทดสอบ', TIER_PENALTY_PER_MONTH: '3500' });
const NOW = Date.parse('2026-08-03T06:00:00Z'); // 13:00 น. เวลาไทย
const sample = { t: NOW, pv: 18, grid: 26, load: 44 };
const window = { start: NOW, elapsedMin: 8, remainMin: 7, energyKwh: 3.5, avgSoFarKw: 26, projectedKw: 28, allowedRestKw: 12, blown: false, hardBlown: false };
const headroom = { peakKw: 26.5, peakAt: NOW, limitKw: 30, headroomKw: 3.5, usedPct: 88, breached: false, monthKey: '2026-08' };
const actions = [{ name: 'แอร์ออฟฟิศชั้น 2', kw: 12, owner: 'ธุรการ' }];

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

/** ข้อความทุกอันต้องไม่มี undefined/NaN หลุดออกไปหาพนักงาน */
function clean(msg, label) {
  assert.ok(msg, `${label}: ไม่ได้ข้อความกลับมา`);
  assert.ok(msg.telegram && msg.telegram.length > 20, `${label}: ข้อความสั้นผิดปกติ`);
  assert.ok(!/undefined|NaN|\[object/.test(msg.telegram), `${label}: มี undefined/NaN หลุดในข้อความ`);
  if (msg.emailSubject) assert.ok(!/undefined|NaN/.test(msg.emailSubject), `${label}: subject มี undefined/NaN`);
  if (msg.emailHtml) assert.ok(!/undefined|NaN/.test(msg.emailHtml), `${label}: อีเมลมี undefined/NaN`);
}

console.log('\nข้อความทุกแบบต้องสร้างได้และสะอาด');

const cases = [
  ['alert เหลือง', { type: 'alert', level: 'yellow', sample, cause: { text: 'โหลดเพิ่มขึ้น' }, actions }],
  ['alert แดง', { type: 'alert', level: 'red', sample, cause: { text: 'แดดหาย' }, actions }],
  ['repeat', { type: 'repeat', level: 'red', sample, cause: { text: 'x' }, actions }],
  ['recover', { type: 'recover', level: 'green', sample, cause: { text: 'x' }, actions: [] }],
  ['escalate', { type: 'escalate', level: 'red', sample, cause: { text: 'x' }, actions, minutesRed: 25 }],
  ['night', { type: 'night', sample: { ...sample, pv: 0, grid: 12, load: 12 }, cause: { text: '' }, actions: [] }],
  ['inverter', { type: 'inverter', sample: { ...sample, pv: 0 }, cause: { text: '' }, actions: [] }],
  ['demand_risk', { type: 'demand_risk', sample, window, headroom, actions }],
  ['demand_risk (หน้าต่างเสียแล้ว)', { type: 'demand_risk', sample, window: { ...window, hardBlown: true, blown: true, allowedRestKw: -3 }, headroom, actions }],
  ['demand_newpeak', { type: 'demand_newpeak', sample, window, headroom, closedWindow: { start: NOW, avgKw: 26.5 } }],
  ['demand_breached', { type: 'demand_breached', sample, window, headroom: { ...headroom, peakKw: 31, headroomKw: -1, breached: true } }],
  ['shed', { type: 'shed', sample, window, headroom, changes: [{ id: 'ac1', name: 'แอร์ชั้น 2', kw: 12, to: 'off' }], dryRun: false }],
  ['shed (dryrun)', { type: 'shed', sample, window, headroom, changes: [{ id: 'ac1', name: 'แอร์ชั้น 2', kw: 12, to: 'off' }], dryRun: true }],
  ['restore', { type: 'restore', sample, window, headroom, changes: [{ id: 'ac1', name: 'แอร์ชั้น 2', kw: 12, to: 'on' }] }],
];

for (const [label, ev] of cases) {
  test(label, () => clean(buildMessage(ev, cfg, NOW), label));
}

console.log('\nเนื้อหาที่ขาดไม่ได้');

test('demand_risk ต้องบอกเวลาที่เหลือ และเพดานที่ใช้ได้', () => {
  const m = buildMessage({ type: 'demand_risk', sample, window, headroom, actions }, cfg, NOW);
  assert.match(m.telegram, /7 นาที/, 'ต้องบอกว่าเหลือกี่นาที');
  assert.match(m.telegram, /12.000 kW/, 'ต้องบอกว่าใช้ได้อีกไม่เกินเท่าไหร่');
  assert.match(m.telegram, /12 เดือน/, 'ต้องย้ำผลที่ตามมา');
  assert.equal(m.toBoss, true, 'เรื่องนี้ต้องถึงหัวหน้าด้วย');
});

test('demand_newpeak ต้องบอกพีคและระยะที่เหลือ', () => {
  const m = buildMessage({ type: 'demand_newpeak', sample, window, headroom, closedWindow: { start: NOW, avgKw: 26.5 } }, cfg, NOW);
  // กำลังไฟแสดงทศนิยม 3 ตำแหน่งตั้งแต่ 4 ส.ค. 2569 (พ่อเต้ยขอ)
  assert.match(m.telegram, /26\.500 kW/);
  assert.match(m.telegram, /3\.500 kW/);
  assert.equal(m.priority, 'normal');
});

test('เหลือระยะน้อยกว่า 3 kW ต้องยกระดับเป็นเรื่องด่วน', () => {
  const tight = { ...headroom, headroomKw: 2, peakKw: 28 };
  const m = buildMessage({ type: 'demand_newpeak', sample, window, headroom: tight, closedWindow: { start: NOW, avgKw: 28 } }, cfg, NOW);
  assert.equal(m.priority, 'high');
});

test('demand_breached ต้องบอกส่วนต่างค่าไฟและเงื่อนไข 12 เดือน', () => {
  const m = buildMessage({ type: 'demand_breached', sample, window, headroom: { ...headroom, peakKw: 31, breached: true } }, cfg, NOW);
  assert.match(m.telegram, /12 เดือน/);
  assert.match(m.telegram, /3,500 บาท/);
});

test('shed แบบ dryrun ต้องบอกชัดว่าเป็นการซ้อม', () => {
  const m = buildMessage({ type: 'shed', sample, window, headroom, changes: [{ id: 'a', name: 'แอร์', kw: 12, to: 'off' }], dryRun: true }, cfg, NOW);
  assert.match(m.telegram, /ซ้อม/);
});

test('shed ต้องบอกวิธีเปิดกลับ', () => {
  const m = buildMessage({ type: 'shed', sample, window, headroom, changes: [{ id: 'a', name: 'แอร์', kw: 12, to: 'off' }], dryRun: false }, cfg, NOW);
  assert.match(m.telegram, /\/restore/);
});

console.log('\nสรุปประจำวัน');

test('สรุปรายวันต้องมีพีคของเดือนและระยะที่เหลือ', () => {
  let state = emptyState();
  let demand = emptyDemand();
  for (let i = 0; i < 24; i++) {
    const t = NOW + i * 5 * 60000;
    state = evaluate(state, { t, pv: 40, grid: 12, load: 52 }, cfg, t).state;
    demand = feedDemand(demand, t, 12, cfg).demand;
  }
  state.demand = demand;
  const m = buildDailySummary(state, cfg, NOW + 24 * 5 * 60000, monthHeadroom(demand, cfg));
  clean(m, 'สรุปรายวัน');
  assert.match(m.telegram, /พีคสะสมของเดือนนี้/);
  assert.match(m.telegram, /เหลือระยะปลอดภัย/);
});

console.log(`\n${pass} เทสต์ผ่าน${process.exitCode ? ' (มีบางข้อไม่ผ่าน)' : ' ทั้งหมด ✨'}\n`);
