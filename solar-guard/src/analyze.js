/**
 * สมองของระบบ: ตัดสินใจว่า "ตอนนี้สถานะอะไร และควรเตือนหรือยัง"
 *
 * หลักคิด 4 ข้อ (ละเอียดอยู่ใน docs/ALERTING.md)
 *   1. เตือนจาก "ไฟที่ซื้อจากการไฟฟ้า (kW)" ไม่ใช่จาก "โซลาร์ผลิตน้อย" — เพราะเมฆบังแป๊บเดียวไม่ใช่ปัญหา
 *   2. ต้องเกินเกณฑ์ต่อเนื่องจริง ๆ ถึงเตือน (กันเตือนหลอกจากเมฆ)
 *   3. มี hysteresis กันสถานะเด้งไปมาแถวเส้นเกณฑ์
 *   4. ทุกข้อความต้องบอกว่า "ให้ไปปิดอะไร" ไม่ใช่แค่บอกว่ามีปัญหา
 */

import { isNight, isPeakSun, isWorkTime, minutesBetween, round1 } from './util.js';

export const LEVELS = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };
const RANK = { green: 0, yellow: 1, red: 2 };

export function emptyState() {
  return {
    level: LEVELS.GREEN,
    levelSince: 0,
    streak: { level: LEVELS.GREEN, count: 0 },
    lastSentLevel: null,
    lastSentAt: 0,
    ackAt: 0,
    ackBy: '',
    mutedUntil: 0,
    lastBossAt: 0,
    lastNightAlertAt: 0,
    lastInverterAlertAt: 0,
    lastSilenceAlertAt: 0,
    peakToday: { kw: 0, at: 0 },
    samples: [],
    lastError: null,
    lastOkAt: 0,
  };
}

/**
 * ระดับดิบตามค่าปัจจุบัน โดยใช้ hysteresis เทียบกับระดับที่เป็นอยู่
 * ขาขึ้นใช้เส้นเต็ม / ขาลงต้องต่ำกว่าเส้นลบ hysteresis ถึงจะถอย
 */
function rawLevel(gridKw, cfg, current) {
  const h = cfg.hysteresisKw;
  const warnOff = cfg.warnKw - h;
  const critOff = cfg.critKw - h;

  if (current === LEVELS.RED) {
    if (gridKw >= critOff) return LEVELS.RED;
    return gridKw >= warnOff ? LEVELS.YELLOW : LEVELS.GREEN;
  }
  if (current === LEVELS.YELLOW) {
    if (gridKw >= cfg.critKw) return LEVELS.RED;
    return gridKw >= warnOff ? LEVELS.YELLOW : LEVELS.GREEN;
  }
  if (gridKw >= cfg.critKw) return LEVELS.RED;
  return gridKw >= cfg.warnKw ? LEVELS.YELLOW : LEVELS.GREEN;
}

/** หาสาเหตุ โดยเทียบกับเมื่อ ~15 นาทีก่อน */
export function detectCause(samples, sample, cfg) {
  const past = samples[samples.length - 3] || samples[samples.length - 2] || samples[0];
  if (!past) return { code: 'unknown', text: 'ยังไม่มีข้อมูลย้อนหลังพอจะบอกสาเหตุ' };

  const dPv = sample.pv - past.pv;
  const dLoad = (sample.load ?? 0) - (past.load ?? 0);
  const bigPvDrop = past.pv > 1 && dPv <= -0.25 * past.pv;
  const bigLoadRise = past.load > 1 && dLoad >= 0.15 * past.load;

  if (isPeakSun(cfg, sample.t) && sample.pv < 0.05 * cfg.systemKwp) {
    return { code: 'inverter', text: 'โซลาร์แทบไม่ผลิตทั้งที่แดดควรจะแรง — อินเวอร์เตอร์อาจหยุดทำงาน ให้แจ้งช่างด่วน' };
  }
  if (bigPvDrop && bigLoadRise) {
    return { code: 'both', text: `แดดตกลง ${round1(-dPv)} kW และโหลดเพิ่มขึ้น ${round1(dLoad)} kW พร้อมกัน` };
  }
  if (bigPvDrop) {
    return { code: 'cloud', text: `แดดหาย โซลาร์ลดลง ${round1(-dPv)} kW ใน 15 นาที` };
  }
  if (bigLoadRise) {
    return { code: 'load', text: `มีการเปิดอุปกรณ์เพิ่ม โหลดขึ้น ${round1(dLoad)} kW ใน 15 นาที` };
  }
  return { code: 'steady', text: 'โหลดสูงต่อเนื่อง ไม่ได้เกิดจากแดดหายกะทันหัน' };
}

/** ค่าเฉลี่ยกำลังไฟ 15 นาทีล่าสุด (ใช้ประมาณ demand ที่การไฟฟ้าคิดเงิน) */
export function demand15(samples, sample) {
  const cutoff = sample.t - 15 * 60000;
  const win = [...samples.filter((s) => s.t >= cutoff), sample];
  if (!win.length) return sample.grid;
  return win.reduce((a, s) => a + (s.grid ?? 0), 0) / win.length;
}

/** เลือกว่าให้ไปปิดอะไรบ้าง ให้พอดีกับส่วนที่เกิน */
export function pickActions(cfg, excessKw) {
  const items = [...cfg.loadShed].sort((a, b) => Number(b.kw) - Number(a.kw));
  const picked = [];
  let remaining = Math.max(0, excessKw);

  for (const it of items) {
    if (remaining <= 0) break;
    picked.push(it);
    remaining -= Number(it.kw) || 0;
  }
  // ถ้ารายการไม่พอ ก็ให้ทั้งหมดเท่าที่มี
  return picked.length ? picked : items.slice(0, 3);
}

/**
 * ประเมินสถานะ + สรุปว่าต้องส่งอะไรบ้าง
 * ไม่แก้ state ตรง ๆ — คืน state ใหม่ออกไป ให้ชั้นบนเป็นคนเซฟ
 */
export function evaluate(prevState, sample, cfg, now = Date.now()) {
  const state = { ...prevState, samples: [...(prevState.samples || [])] };
  const events = [];
  const grid = sample.grid ?? 0;

  // ---------- 1) อัปเดต streak ----------
  const raw = rawLevel(grid, cfg, state.level);
  if (state.streak?.level === raw) state.streak = { level: raw, count: state.streak.count + 1 };
  else state.streak = { level: raw, count: 1 };

  // ---------- 2) ยืนยันระดับ (ต้องต่อเนื่องจริง) ----------
  const goingUp = RANK[raw] > RANK[state.level];
  const goingDown = RANK[raw] < RANK[state.level];
  const need = goingUp ? cfg.sustainPolls : cfg.recoverPolls;
  let levelChanged = false;

  if (raw !== state.level && state.streak.count >= need) {
    state.level = raw;
    state.levelSince = now;
    levelChanged = true;
    if (goingDown) {
      state.ackAt = 0;
      state.ackBy = '';
      state.lastBossAt = 0;
    }
  }

  // ---------- 3) ข้อมูลประกอบ ----------
  const cause = detectCause(state.samples, sample, cfg);
  const d15 = demand15(state.samples, sample);
  const excess = Math.max(0, grid - (state.level === LEVELS.RED ? 0 : cfg.warnKw));
  const actions = state.level === LEVELS.GREEN ? [] : pickActions(cfg, state.level === LEVELS.RED ? grid : excess);

  const ctx = { sample, cause, demand15: d15, actions, level: state.level, excessKw: excess };

  // ---------- 4) ตัดสินใจว่าจะส่งอะไร ----------
  const muted = now < (state.mutedUntil || 0);
  const acked = state.ackAt > 0 && minutesBetween(now, state.ackAt) < cfg.ackSuppressMin;
  const inWork = isWorkTime(cfg, now);

  if (!muted) {
    if (levelChanged && state.level === LEVELS.GREEN && RANK[prevState.level] > 0) {
      events.push({ type: 'recover', ...ctx });
    } else if (levelChanged && state.level === LEVELS.RED) {
      events.push({ type: 'alert', ...ctx });
    } else if (levelChanged && state.level === LEVELS.YELLOW && RANK[prevState.level] < 1) {
      // เหลืองนอกเวลางานไม่ต้องกวน (ไม่มีคนอยู่ให้ไปปิดอยู่แล้ว)
      if (inWork || cfg.alertYellowOutsideWork) events.push({ type: 'alert', ...ctx });
    } else if (state.level !== LEVELS.GREEN && !acked) {
      // ยังไม่หาย และไม่มีใครกด /ack -> ย้ำซ้ำเป็นระยะ
      const since = state.lastSentAt || state.levelSince;
      if (minutesBetween(now, since) >= cfg.repeatMin && (inWork || state.level === LEVELS.RED)) {
        events.push({ type: 'repeat', ...ctx });
      }
    }

    // ตามหัวหน้า: แดงนานเกินกำหนดแล้วยังไม่มีใครรับเรื่อง
    if (
      state.level === LEVELS.RED &&
      !acked &&
      minutesBetween(now, state.levelSince) >= cfg.escalateMin &&
      minutesBetween(now, state.lastBossAt || 0) >= cfg.escalateMin
    ) {
      events.push({ type: 'escalate', ...ctx, minutesRed: Math.round(minutesBetween(now, state.levelSince)) });
      state.lastBossAt = now;
    }

    // เกินเพดาน demand ที่ตั้งไว้ (ค่าความต้องการพลังไฟฟ้าคิดเงินแพง)
    if (cfg.peakDemandTargetKw > 0 && d15 >= cfg.peakDemandTargetKw && minutesBetween(now, state.lastSentAt || 0) >= 15) {
      events.push({ type: 'demand', ...ctx });
    }

    // กลางคืน: มีอุปกรณ์เปิดค้าง
    if (
      cfg.nightWatch &&
      isNight(cfg, now) &&
      grid >= cfg.nightIdleKw &&
      minutesBetween(now, state.lastNightAlertAt || 0) >= 120
    ) {
      events.push({ type: 'night', ...ctx });
      state.lastNightAlertAt = now;
    }

    // อินเวอร์เตอร์เงียบทั้งที่แดดแรง
    if (
      cfg.inverterWatch &&
      isPeakSun(cfg, now) &&
      sample.pv < 0.05 * cfg.systemKwp &&
      state.streak.count >= cfg.sustainPolls &&
      minutesBetween(now, state.lastInverterAlertAt || 0) >= 180
    ) {
      events.push({ type: 'inverter', ...ctx });
      state.lastInverterAlertAt = now;
    }
  }

  if (events.some((e) => ['alert', 'repeat', 'recover', 'demand'].includes(e.type))) {
    state.lastSentAt = now;
    state.lastSentLevel = state.level;
  }

  // ---------- 5) เก็บประวัติ ----------
  state.samples.push(sample);
  const dayAgo = now - 26 * 60 * 60 * 1000;
  state.samples = state.samples.filter((s) => s.t >= dayAgo).slice(-320);

  if (grid > (state.peakToday?.kw || 0)) state.peakToday = { kw: grid, at: now };
  state.lastOkAt = now;
  state.lastError = null;

  return { state, events, cause, demand15: d15, actions };
}
