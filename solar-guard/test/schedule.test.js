/**
 * ทดสอบตัวเฝ้างานประจำ — จำลองเหตุการณ์จริงที่ทำให้โดนค่าไฟแพงทั้งปี
 * รันด้วย:  node test/schedule.test.js
 */

import assert from 'node:assert';
import { loadConfig } from '../src/config.js';
import { baselineLoad, checkSchedule, emptyScheduleState, taskTimeToday } from '../src/schedule.js';
import { buildMessage } from '../src/messages.js';

const cfg = loadConfig({
  SITE_NAME: 'โรงงานทดสอบ',
  DAILY_TASKS: JSON.stringify([
    { id: 'ac_1500', name: 'ปิดแอร์ 3 ตัว', at: '15:00', graceMin: 10, expectDropKw: 8, repeatMin: 10, giveUpMin: 90, days: [1, 2, 3, 4, 5, 6], owner: 'ฝ่ายธุรการ' },
  ]),
});

const MIN = 60000;
// 2026-08-03 เป็นวันจันทร์ — 15:00 น. เวลาไทย = 08:00 UTC
const T1500 = Date.parse('2026-08-03T08:00:00Z');

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

/** สร้างชุดข้อมูลย้อนหลังก่อนถึงเวลานัด ที่โหลดคงที่ */
function historyBefore(loadKw, taskTs, minutes = 30) {
  const out = [];
  for (let m = minutes; m >= 5; m -= 5) {
    out.push({ t: taskTs - m * MIN, pv: 15, grid: loadKw - 15, load: loadKw });
  }
  return out;
}

/** เดินเวลาไปข้างหน้าทีละ 5 นาที ด้วยค่าโหลดที่กำหนด */
function advance(state, samples, loadSeries, startAt) {
  let s = state;
  const all = [...samples];
  const events = [];
  loadSeries.forEach(([minOffset, loadKw]) => {
    const t = startAt + minOffset * MIN;
    const sample = { t, pv: 8, grid: loadKw - 8, load: loadKw };
    const res = checkSchedule(s, sample, all, cfg, t);
    s = res.state;
    events.push(...res.events);
    all.push(sample);
  });
  return { state: s, events };
}

console.log('\nพื้นฐาน');

test('แปลงเวลา 15:00 เป็นเวลาไทยได้ถูกต้อง', () => {
  assert.equal(taskTimeToday('15:00', T1500), T1500);
  assert.equal(taskTimeToday('15:00', T1500 + 3 * 3600000), T1500, 'ถามตอน 18:00 ก็ยังต้องได้ 15:00 ของวันเดียวกัน');
});

test('คำนวณโหลดฐานจากช่วงก่อนถึงเวลานัด', () => {
  const b = baselineLoad(historyBefore(30, T1500), T1500);
  assert.ok(Math.abs(b - 30) < 0.1, `ได้ ${b}`);
});

test('ข้อมูลย้อนหลังไม่พอ = ไม่ตัดสิน ไม่เตือนมั่ว', () => {
  const res = checkSchedule(emptyScheduleState(), { t: T1500 + 15 * MIN, pv: 5, grid: 25, load: 30 }, [], cfg, T1500 + 15 * MIN);
  assert.equal(res.events.length, 0);
});

console.log('\nเคสปกติ: มีคนปิดแอร์');

test('ปิดแอร์แล้วโหลดลดลง -> ไม่เตือน และบอกว่าเรียบร้อย', () => {
  const hist = historyBefore(30, T1500);
  // 15:00 มีคนปิดแอร์ 3 ตัว โหลดลดจาก 30 เหลือ 20
  const { events } = advance(emptyScheduleState(), hist, [[10, 20], [15, 20], [20, 20]], T1500);
  assert.equal(events.filter((e) => e.type === 'task_missed').length, 0, 'ห้ามเตือนเมื่อมีคนทำแล้ว');
  assert.equal(events.filter((e) => e.type === 'task_done').length, 1);
});

test('ปิดช้าไปหน่อยแต่ปิดแล้ว -> เตือนรอบเดียวแล้วหยุด', () => {
  const hist = historyBefore(30, T1500);
  const { events } = advance(emptyScheduleState(), hist, [[10, 30], [20, 20], [30, 20]], T1500);
  assert.equal(events.filter((e) => e.type === 'task_missed').length, 1, 'เตือนรอบเดียวพอ');
  assert.equal(events.filter((e) => e.type === 'task_done').length, 1, 'พอปิดแล้วต้องบอกว่าเรียบร้อย');
});

console.log('\nเคสจริงที่ทำให้โดนค่าไฟแพงทั้งปี');

test('คนที่รับผิดชอบลา ไม่มีใครปิดแอร์ -> ต้องรู้ภายใน 10 นาที ไม่ใช่ 5 ชั่วโมง', () => {
  const hist = historyBefore(30, T1500);
  const { events } = advance(emptyScheduleState(), hist, [[10, 30]], T1500);
  const missed = events.filter((e) => e.type === 'task_missed');
  assert.equal(missed.length, 1, 'ต้องเตือนตั้งแต่ 15:10');
  assert.equal(missed[0].overdueMin, 10);
  assert.ok(missed[0].dropKw < 8, 'ต้องตรวจได้ว่าโหลดไม่ลด');
});

test('ยังไม่มีใครทำ -> ย้ำเป็นระยะ และรอบที่ 2 ต้องตามหัวหน้า', () => {
  const hist = historyBefore(30, T1500);
  const { events } = advance(emptyScheduleState(), hist, [[10, 30], [20, 30], [30, 30]], T1500);
  const missed = events.filter((e) => e.type === 'task_missed');
  assert.equal(missed.length, 3);
  assert.equal(missed[0].toBoss, false, 'รอบแรกเข้ากลุ่มพอ');
  assert.equal(missed[1].toBoss, true, 'รอบสองต้องถึงหัวหน้า — เพราะคนที่รับผิดชอบอาจไม่อยู่');
});

test('เลยเวลามานาน -> หยุดย้ำ แต่ต้องสรุปว่าวันนี้ไม่มีใครทำ', () => {
  const hist = historyBefore(30, T1500);
  const series = [];
  for (let m = 10; m <= 100; m += 10) series.push([m, 30]);
  const { events } = advance(emptyScheduleState(), hist, series, T1500);
  assert.equal(events.filter((e) => e.type === 'task_failed').length, 1);
  const lastMissed = events.filter((e) => e.type === 'task_missed').length;
  assert.ok(lastMissed <= 9, `ย้ำ ${lastMissed} ครั้ง ไม่ควรย้ำไม่รู้จบ`);
});

console.log('\nแยกให้ออกระหว่าง "ไม่มีคนปิด" กับ "แดดหาย"');

test('แดดหายแต่มีคนปิดแอร์แล้ว -> ต้องไม่เตือน (นี่คือเหตุผลที่ต้องวัดโหลดรวม ไม่ใช่ไฟที่ซื้อ)', () => {
  const hist = historyBefore(30, T1500);
  // มีคนปิดแอร์ (โหลดรวมลด 30->20) แต่แดดหายด้วย ทำให้ไฟที่ซื้อพุ่งจาก 15 เป็น 20
  const t = T1500 + 10 * MIN;
  const res = checkSchedule(emptyScheduleState(), { t, pv: 0, grid: 20, load: 20 }, hist, cfg, t);
  assert.equal(res.events.filter((e) => e.type === 'task_missed').length, 0, 'ไฟที่ซื้อสูงขึ้นแต่โหลดลด = มีคนปิดแล้ว');
  assert.equal(res.events.filter((e) => e.type === 'task_done').length, 1);
});

test('ไม่มีคนปิด และแดดยังดี -> ต้องเตือน แม้ไฟที่ซื้อยังต่ำ', () => {
  const hist = historyBefore(30, T1500);
  const t = T1500 + 10 * MIN;
  const res = checkSchedule(emptyScheduleState(), { t, pv: 25, grid: 5, load: 30 }, hist, cfg, t);
  assert.equal(res.events.filter((e) => e.type === 'task_missed').length, 1, 'โหลดยังเท่าเดิม = ยังไม่มีใครปิด');
});

console.log('\nกฎอื่น ๆ');

test('วันอาทิตย์ไม่ต้องตรวจ', () => {
  const sunday = Date.parse('2026-08-02T08:00:00Z'); // อาทิตย์ 15:00 น.
  const hist = historyBefore(30, sunday);
  const t = sunday + 10 * MIN;
  const res = checkSchedule(emptyScheduleState(), { t, pv: 5, grid: 25, load: 30 }, hist, cfg, t);
  assert.equal(res.events.length, 0);
});

test('ยังไม่ถึงเวลา ไม่ต้องเตือน', () => {
  const hist = historyBefore(30, T1500);
  const t = T1500 - 5 * MIN;
  const res = checkSchedule(emptyScheduleState(), { t, pv: 15, grid: 15, load: 30 }, hist, cfg, t);
  assert.equal(res.events.length, 0);
});

test('พิมพ์ /done แล้วต้องหยุดย้ำ', () => {
  const hist = historyBefore(30, T1500);
  const first = advance(emptyScheduleState(), hist, [[10, 30]], T1500);
  // จำลองการกด /done
  const acked = { tasks: { ac_1500: { ...first.state.tasks.ac_1500, done: true, doneAt: T1500 + 12 * MIN } } };
  const t = T1500 + 25 * MIN;
  const res = checkSchedule(acked, { t, pv: 5, grid: 25, load: 30 }, hist, cfg, t);
  assert.equal(res.events.length, 0, 'กด /done แล้วต้องเงียบ');
});

test('ขึ้นวันใหม่ต้องเริ่มนับใหม่', () => {
  const hist = historyBefore(30, T1500);
  const day1 = advance(emptyScheduleState(), hist, [[10, 30], [20, 30]], T1500);
  assert.ok(day1.state.tasks.ac_1500.alertCount >= 2);

  const T2 = T1500 + 24 * 3600000; // อังคาร 15:00
  const hist2 = historyBefore(30, T2);
  const day2 = advance(day1.state, hist2, [[10, 20]], T2);
  assert.equal(day2.events.filter((e) => e.type === 'task_missed').length, 0);
  assert.equal(day2.state.tasks.ac_1500.dayKey !== day1.state.tasks.ac_1500.dayKey, true);
});

console.log('\nข้อความ');

test('ข้อความรอบแรกต้องบอกตัวเลขที่ใช้ตัดสิน', () => {
  const hist = historyBefore(30, T1500);
  const { events } = advance(emptyScheduleState(), hist, [[10, 30]], T1500);
  const m = buildMessage(events[0], cfg, T1500 + 10 * MIN);
  assert.match(m.telegram, /15:00/);
  assert.match(m.telegram, /โหลดรวมก่อนถึงเวลา 30 kW/, 'ต้องบอกโหลดฐาน');
  assert.match(m.telegram, /ตอนนี้ 30 kW/, 'ต้องบอกโหลดปัจจุบันเทียบกัน');
  assert.ok(!/undefined|NaN/.test(m.telegram));
  assert.match(m.telegram, /\/done/);
});

test('ข้อความรอบที่ 2 ต้องดังขึ้นและบอกว่าใครก็ได้ช่วยไปปิด', () => {
  const hist = historyBefore(30, T1500);
  const { events } = advance(emptyScheduleState(), hist, [[10, 30], [20, 30]], T1500);
  const m = buildMessage(events[1], cfg, T1500 + 20 * MIN);
  assert.equal(m.priority, 'high');
  assert.equal(m.toBoss, true);
  assert.match(m.telegram, /ไม่ต้องรอเจ้าของงาน/);
});

test('ข้อความสรุปตอนเลยเวลาต้องแนะนำให้ตั้งคนสำรอง', () => {
  const hist = historyBefore(30, T1500);
  const series = [];
  for (let m = 10; m <= 100; m += 10) series.push([m, 30]);
  const { events } = advance(emptyScheduleState(), hist, series, T1500);
  const failed = events.find((e) => e.type === 'task_failed');
  const m = buildMessage(failed, cfg, T1500 + 100 * MIN);
  assert.match(m.telegram, /คนสำรอง/);
  assert.equal(m.toBoss, true);
});

console.log(`\n${pass} เทสต์ผ่าน${process.exitCode ? ' (มีบางข้อไม่ผ่าน)' : ' ทั้งหมด ✨'}\n`);
