/**
 * ทดสอบสมองของระบบ (ไม่ต้องต่อเน็ต ไม่ต้องมี Cloudflare)
 * รันด้วย:  node test/analyze.test.js
 */

import assert from 'node:assert';
import { loadConfig } from '../src/config.js';
import { activeThresholds, emptyState, evaluate, pickActions } from '../src/analyze.js';
import { buildDailySummary, buildMessage } from '../src/messages.js';

const cfg = loadConfig({
  WARN_IMPORT_KW: '15',
  CRIT_IMPORT_KW: '30',
  HYSTERESIS_KW: '5',
  SUSTAIN_POLLS: '2',
  RECOVER_POLLS: '3',
  SYSTEM_KWP: '100',
  WORK_START_HOUR: '8',
  WORK_END_HOUR: '17',
  SITE_NAME: 'โรงงานทดสอบ',
});

// 2026-08-03 เป็นวันจันทร์ — 13:00 น. เวลาไทย = 06:00 UTC
const NOON = Date.parse('2026-08-03T06:00:00Z');
const FIVE_MIN = 5 * 60000;

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

/**
 * ป้อนค่าไฟหลายรอบติดกัน
 * คืน events = เหตุการณ์ของรอบสุดท้าย, allEvents = ทุกเหตุการณ์ที่เกิดตลอดชุด
 */
function feed(state, series, startAt = NOON) {
  let s = state;
  let last = null;
  const allEvents = [];
  series.forEach((row, i) => {
    const t = startAt + i * FIVE_MIN;
    const sample = { t, pv: row.pv, grid: row.grid, load: row.pv + row.grid };
    last = evaluate(s, sample, cfg, t);
    allEvents.push(...last.events);
    s = last.state;
  });
  return { ...last, allEvents };
}

console.log('\nสถานะและการเตือน');

test('ไฟหลวงต่ำ = เขียว ไม่มีการเตือน', () => {
  const out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 58, grid: 4 },
    { pv: 61, grid: 2 },
  ]);
  assert.equal(out.state.level, 'green');
  assert.equal(out.events.length, 0);
});

test('เมฆบังแป๊บเดียว (เกินเกณฑ์รอบเดียว) ต้องไม่เตือน', () => {
  // ค่าที่ใช้ต้องต่ำกว่า instantTripKw ไม่งั้นจะไปเข้าเส้น "ณ ขณะนั้น"
  // ซึ่งตั้งใจให้เตือนทันทีอยู่แล้ว การกันเตือนหลอนใช้ได้เฉพาะใต้เส้นนั้น
  const out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 20, grid: 20 }, // เมฆบัง 5 นาที
    { pv: 58, grid: 4 }, // แดดกลับมา
  ]);
  assert.equal(out.state.level, 'green', 'ยังต้องเป็นเขียว');
  assert.equal(out.events.length, 0, 'ห้ามมีข้อความเตือน');
});

test('แตะเส้น "ณ ขณะนั้น" ครั้งเดียว = แดงทันที ไม่รอรอบที่สอง', () => {
  // โรงงานนี้โดนปรับจากค่า ณ ขณะนั้น ไม่ใช่ค่าเฉลี่ย 15 นาที
  // กว่าจะครบ SUSTAIN_POLLS ก็สายไปแล้ว เส้นนี้จึงข้ามการรอทั้งหมด
  const out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 10, grid: cfg.instantTripKw + 1 },
  ]);
  assert.equal(out.state.level, 'red', 'ต้องแดงตั้งแต่ตัวอย่างแรกที่แตะเส้น');
  const alerts = out.events.filter((e) => e.type === 'alert');
  assert.equal(alerts.length, 1, 'ต้องเตือนในรอบเดียวกันนั้นเลย');
  assert.equal(alerts[0].level, 'red');
});

test('เกินเกณฑ์แดงต่อเนื่อง 10 นาที = เตือนแดง 1 ครั้ง', () => {
  const out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 20, grid: 35 },
    { pv: 18, grid: 36 },
  ]);
  assert.equal(out.state.level, 'red');
  // ค่า 35 เกินเส้น "ณ ขณะนั้น" จึงเตือนตั้งแต่ตัวอย่างที่ 2 ไม่ใช่ตัวอย่างที่ 3
  // ต้องนับจาก allEvents และต้องได้ใบเดียวเท่านั้น (ตัวอย่างที่ 3 ห้ามเตือนซ้ำ)
  const alerts = out.allEvents.filter((e) => e.type === 'alert');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
});

test('เตือนแล้วรอบถัดไปไม่เตือนซ้ำ (กันสแปม)', () => {
  const out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 20, grid: 35 },
    { pv: 18, grid: 36 },
    { pv: 18, grid: 37 },
    { pv: 19, grid: 34 },
  ]);
  assert.equal(out.events.filter((e) => e.type === 'alert').length, 0);
});

test('hysteresis: ตกลงมาที่ 27 kW ยังไม่ถือว่าหายแดง (เกณฑ์ลง = 30-5)', () => {
  let out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 20, grid: 35 },
    { pv: 18, grid: 36 },
  ]);
  out = feed(out.state, [
    { pv: 25, grid: 27 },
    { pv: 25, grid: 27 },
    { pv: 25, grid: 27 },
  ], NOON + 3 * FIVE_MIN);
  assert.equal(out.state.level, 'red');
});

test('ลดลงต่อเนื่อง 15 นาที = ส่งข้อความกลับสู่ปกติ', () => {
  let out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 20, grid: 35 },
    { pv: 18, grid: 36 },
  ]);
  out = feed(out.state, [
    { pv: 55, grid: 5 },
    { pv: 57, grid: 4 },
    { pv: 58, grid: 3 },
  ], NOON + 3 * FIVE_MIN);
  assert.equal(out.state.level, 'green');
  assert.equal(out.events.filter((e) => e.type === 'recover').length, 1);
});

test('กด /ack แล้วต้องไม่ย้ำซ้ำ', () => {
  let out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 20, grid: 35 },
    { pv: 18, grid: 36 },
  ]);
  const acked = { ...out.state, ackAt: NOON + 3 * FIVE_MIN, ackBy: 'สมชาย' };
  const later = NOON + 12 * FIVE_MIN; // อีก 45 นาที
  const res = evaluate(acked, { t: later, pv: 18, grid: 36, load: 54 }, cfg, later);
  assert.equal(res.events.filter((e) => e.type === 'repeat').length, 0);
});

test('แดงนานเกิน 20 นาทีโดยไม่มีใครรับเรื่อง = ตามหัวหน้า', () => {
  let out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 20, grid: 35 },
    { pv: 18, grid: 36 },
  ]);
  const later = out.state.levelSince + 25 * 60000;
  const res = evaluate(out.state, { t: later, pv: 18, grid: 36, load: 54 }, cfg, later);
  assert.equal(res.events.filter((e) => e.type === 'escalate').length, 1);
});

test('/mute แล้วต้องเงียบสนิท', () => {
  const state = { ...emptyState(), mutedUntil: NOON + 60 * 60000 };
  const out = feed(state, [
    { pv: 20, grid: 35 },
    { pv: 18, grid: 36 },
    { pv: 18, grid: 37 },
  ]);
  assert.equal(out.events.length, 0);
});

console.log('\nการหาสาเหตุ');

test('แดดหาย -> บอกว่าแดดหาย', () => {
  const out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 55, grid: 8 },
    { pv: 20, grid: 40 },
    { pv: 18, grid: 42 },
  ]);
  assert.match(out.cause.text, /แดดหาย|แดดตกลง/);
});

test('โหลดเพิ่ม -> บอกว่าเปิดอุปกรณ์เพิ่ม', () => {
  const out = feed(emptyState(), [
    { pv: 60, grid: 2 },
    { pv: 60, grid: 3 },
    { pv: 60, grid: 35 },
    { pv: 60, grid: 36 },
  ]);
  assert.match(out.cause.text, /เปิดอุปกรณ์เพิ่ม|โหลดขึ้น/);
});

test('แดดแรงแต่โซลาร์ไม่ผลิต -> เตือนเรื่องอินเวอร์เตอร์', () => {
  const out = feed(emptyState(), [
    { pv: 0, grid: 40 },
    { pv: 0, grid: 41 },
    { pv: 0, grid: 42 },
  ]);
  assert.equal(out.allEvents.filter((e) => e.type === 'inverter').length, 1);
});

console.log('\nกลางคืน');

test('กลางคืนใช้ไฟเกินเกณฑ์ = เตือนของเปิดค้าง', () => {
  const night = Date.parse('2026-08-03T15:00:00Z'); // 22:00 น. เวลาไทย
  const out = feed(emptyState(), [{ pv: 0, grid: 12 }], night);
  assert.equal(out.events.filter((e) => e.type === 'night').length, 1);
});

test('กลางคืนใช้ไฟน้อย = ไม่เตือน', () => {
  const night = Date.parse('2026-08-03T15:00:00Z');
  const out = feed(emptyState(), [{ pv: 0, grid: 3 }], night);
  assert.equal(out.events.filter((e) => e.type === 'night').length, 0);
});

console.log('\nรายการสิ่งที่ให้ไปปิด');

test('เลือกอุปกรณ์ให้พอกับส่วนที่เกิน', () => {
  const picked = pickActions(cfg, 20);
  const total = picked.reduce((a, x) => a + x.kw, 0);
  assert.ok(total >= 20, `รวมได้ ${total} kW ต้อง >= 20`);
});

test('เกินนิดเดียวก็เลือกแค่ตัวเดียว', () => {
  const picked = pickActions(cfg, 5);
  assert.equal(picked.length, 1);
});

console.log('\nข้อความ');

test('ข้อความแดงต้องมีตัวเลข kW เงิน และรายการให้ไปปิด', () => {
  const out = feed(emptyState(), [
    { pv: 60, grid: 3 },
    { pv: 20, grid: 35 },
    { pv: 18, grid: 36 },
  ]);
  // เตือนตั้งแต่ตัวอย่างที่ 2 (35 kW) เพราะเกินเส้น "ณ ขณะนั้น" แล้ว
  // ข้อความจึงต้องอ้างค่าที่ทำให้เตือน ไม่ใช่ค่าล่าสุด
  const msg = buildMessage(out.allEvents.find((e) => e.type === 'alert'), cfg, NOON);
  assert.match(msg.telegram, /35 kW/);
  assert.match(msg.telegram, /บาท\/ชั่วโมง/);
  assert.match(msg.telegram, /ให้ทำตามลำดับนี้/);
  assert.match(msg.telegram, /\/ack/);
  assert.equal(msg.priority, 'high');
});

test('สรุปประจำวันคำนวณ kWh และเงินได้', () => {
  let state = emptyState();
  for (let i = 0; i < 12; i++) {
    const t = NOON + i * FIVE_MIN;
    state = evaluate(state, { t, pv: 50, grid: 10, load: 60 }, cfg, t).state;
  }
  const msg = buildDailySummary(state, cfg, NOON + 12 * FIVE_MIN);
  assert.match(msg.telegram, /kWh/);
  assert.match(msg.telegram, /ประหยัดได้วันนี้/);
});

console.log('\nเฝ้าระวัง: ซื้อไฟมากกว่าที่โซลาร์ผลิตได้');

// 2026-08-03 12:00 น. เวลาไทย = 05:00 UTC — อยู่ในช่วงแดดแรง (10:00-15:00)
const SUN = Date.parse('2026-08-03T05:00:00Z');
// 2026-08-03 20:00 น. เวลาไทย = 13:00 UTC — พ้นช่วงแดดแล้ว
const EVENING = Date.parse('2026-08-03T13:00:00Z');
const hasPvBelow = (out) => out.allEvents.some((e) => e.type === 'pv_below_grid');

test('แดดแรงแต่ซื้อไฟมากกว่าโซลาร์ผลิต -> เตือน', () => {
  const out = feed(emptyState(), [
    { pv: 5, grid: 12 },
    { pv: 5, grid: 12 },
    { pv: 4, grid: 13 },
  ], SUN);
  assert.ok(hasPvBelow(out), 'ควรได้ข้อความเตือน');
});

test('กลางคืนต้องไม่เตือน แม้โซลาร์ผลิต 0 และซื้อไฟอยู่', () => {
  const out = feed(emptyState(), [
    { pv: 0, grid: 10 },
    { pv: 0, grid: 10 },
    { pv: 0, grid: 10 },
    { pv: 0, grid: 10 },
  ], EVENING);
  assert.ok(!hasPvBelow(out), 'กลางคืนเข้าเงื่อนไขอยู่แล้วทุกคืน ต้องไม่เตือน');
});

test('โซลาร์ผลิตมากกว่าที่ซื้อ -> ไม่เตือน', () => {
  const out = feed(emptyState(), [
    { pv: 40, grid: 5 },
    { pv: 42, grid: 4 },
    { pv: 41, grid: 5 },
  ], SUN);
  assert.ok(!hasPvBelow(out), 'สถานการณ์ปกติต้องเงียบ');
});

test('เมฆบังรอบเดียวต้องไม่เตือน (ต้องต่อเนื่องก่อน)', () => {
  const out = feed(emptyState(), [
    { pv: 40, grid: 5 },
    { pv: 3, grid: 12 }, // เมฆบังรอบเดียว
    { pv: 40, grid: 5 },
  ], SUN);
  assert.ok(!hasPvBelow(out), 'ต้องรอให้ต่อเนื่องตาม SUSTAIN_POLLS ก่อน');
});

test('ตอนไฟแดงต้องเงียบ ไม่แย่งพื้นที่กับใบที่บอกให้ไปปิดอะไร', () => {
  const out = feed(emptyState(), [
    { pv: 2, grid: 40 },
    { pv: 2, grid: 40 },
    { pv: 2, grid: 40 },
    { pv: 2, grid: 40 },
  ], SUN);
  assert.equal(out.state.level, 'red', 'สถานการณ์นี้ต้องเป็นไฟแดง');
  assert.ok(!hasPvBelow(out), 'ตอนแดงต้องไม่ส่งใบวิเคราะห์ประสิทธิภาพมาแข่ง');
});

test('ข้อความที่ส่งต้องบอกทั้งสองสาเหตุที่เป็นไปได้', () => {
  const out = feed(emptyState(), [
    { pv: 5, grid: 12 },
    { pv: 5, grid: 12 },
    { pv: 4, grid: 13 },
  ], SUN);
  const ev = out.allEvents.find((e) => e.type === 'pv_below_grid');
  const msg = buildMessage(ev, cfg);
  assert.match(msg.telegram, /โหลดสูงผิดปกติ/);
  assert.match(msg.telegram, /โซลาร์ผลิตได้น้อยผิดปกติ/);
});

console.log('\nเฝ้าระวังเข้มช่วงเย็น (15:00 จนจบ on-peak)');

const evcfg = loadConfig({
  WARN_IMPORT_KW: '16',
  CRIT_IMPORT_KW: '19',
  EVENING_WATCH_HOUR: '15',
  EVENING_WATCH_TIGHTEN_KW: '3',
  SUSTAIN_POLLS: '2',
});
const at = (iso) => Date.parse(iso);

test('เกณฑ์เข้มขึ้นเฉพาะ 15:00-22:00 วันจันทร์-ศุกร์', () => {
  const cases = [
    ['2026-08-03T06:00:00Z', false, 'จันทร์ 13:00 ยังไม่ถึงเวลา'],
    ['2026-08-03T07:59:00Z', false, 'จันทร์ 14:59 ยังไม่ถึงเวลา'],
    ['2026-08-03T08:00:00Z', true, 'จันทร์ 15:00 เริ่มเข้ม'],
    ['2026-08-03T11:00:00Z', true, 'จันทร์ 18:00 ยังเข้มอยู่'],
    ['2026-08-03T14:59:00Z', true, 'จันทร์ 21:59 ยังเข้มอยู่'],
    ['2026-08-03T15:00:00Z', false, 'จันทร์ 22:00 จบ on-peak แล้ว'],
    ['2026-08-02T09:00:00Z', false, 'อาทิตย์ 16:00 ไม่มีค่า demand ไม่ต้องเข้ม'],
    ['2026-08-08T09:00:00Z', false, 'เสาร์ 16:00 ไม่มีค่า demand ไม่ต้องเข้ม'],
  ];
  for (const [iso, want, why] of cases) {
    assert.equal(activeThresholds(evcfg, at(iso)).evening, want, why);
  }
});

test('ตอนเข้ม เกณฑ์ต้องลดลงตามที่ตั้งไว้', () => {
  const th = activeThresholds(evcfg, at('2026-08-03T09:00:00Z')); // จันทร์ 16:00
  assert.equal(th.warnKw, 13, 'เหลือง 16 - 3');
  assert.equal(th.critKw, 16, 'แดง 19 - 3');
});

test('ไฟหลวงเท่าเดิม แต่ตอนเย็นต้องขึ้นเหลือง ตอนบ่ายยังเขียว', () => {
  const series = [{ pv: 5, grid: 14 }, { pv: 5, grid: 14 }, { pv: 5, grid: 14 }];
  const noon = feed(emptyState(), series, at('2026-08-03T06:00:00Z')); // 13:00
  const eve = feed(emptyState(), series, at('2026-08-03T09:00:00Z')); // 16:00
  assert.equal(noon.state.level, 'green', '14 kW ตอนบ่ายยังต่ำกว่าเกณฑ์ปกติ 16');
  assert.equal(eve.state.level, 'yellow', '14 kW ตอนเย็นต้องเกินเกณฑ์เข้ม 13');
});

test('ปิดสวิตช์ EVENING_WATCH แล้วต้องกลับไปใช้เกณฑ์ปกติ', () => {
  const off = loadConfig({ WARN_IMPORT_KW: '16', CRIT_IMPORT_KW: '19', EVENING_WATCH: 'false' });
  const th = activeThresholds(off, at('2026-08-03T09:00:00Z'));
  assert.equal(th.evening, false);
  assert.equal(th.warnKw, 16);
});

console.log(`\n${pass} เทสต์ผ่าน${process.exitCode ? ' (มีบางข้อไม่ผ่าน)' : ' ทั้งหมด ✨'}\n`);
