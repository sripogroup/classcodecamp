/**
 * เครื่องคิดค่าความต้องการพลังไฟฟ้า (Demand) ตามที่การไฟฟ้าคิดจริง
 *
 * กฎที่ต้องรอด:
 *   ผู้ใช้ไฟประเภทที่ 2 ถ้าเดือนไหนมี "ค่าเฉลี่ย 15 นาทีสูงสุด" ตั้งแต่ 30 kW ขึ้นไป
 *   จะถูกย้ายไปประเภทที่ 3 และต้องต่ำกว่า 30 kW ติดต่อกัน 12 เดือนถึงจะกลับมาได้
 *
 * แปลว่า:
 *   - พลาดหน้าต่าง 15 นาทีเดียว = จ่ายแพงทั้งปี
 *   - ตัวเลขที่ต้องเฝ้าคือ "พีคสูงสุดของเดือน" ไม่ใช่ค่า ณ ปัจจุบัน
 *   - ค่าพุ่งแวบเดียว (มอเตอร์สตาร์ท) ไม่นับ เพราะเฉลี่ย 15 นาทีแล้วหาย
 *
 * การไฟฟ้าวัดเป็นหน้าต่างตายตัวตามหน้าปัดนาฬิกา (นาทีที่ 0-15, 15-30, 30-45, 45-60)
 * ไม่ใช่หน้าต่างเลื่อน — โค้ดนี้จึงคิดตามขอบนาฬิกาเหมือนกัน
 */

import { thTime } from './util.js';

export const WINDOW_MIN = 15;
export const WINDOW_H = WINDOW_MIN / 60; // 0.25 ชั่วโมง
const MAX_GAP_MIN = 30; // ขาดข้อมูลนานกว่านี้ = เดาต่อไม่ได้ ต้องเริ่มหน้าต่างใหม่

/** จุดเริ่มของหน้าต่าง 15 นาทีที่เวลา ts ตกอยู่ (อิงขอบนาฬิกา) */
export function windowStart(ts) {
  const d = new Date(ts);
  const offsetMs = (d.getUTCMinutes() % WINDOW_MIN) * 60000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();
  return ts - offsetMs;
}

/** คีย์เดือนตามปฏิทินไทย เช่น "2026-08" */
export function monthKey(ts) {
  const t = thTime(ts);
  return `${t.year}-${String(t.month).padStart(2, '0')}`;
}

export function emptyDemand() {
  return {
    winStart: 0,
    energyKwh: 0, // พลังงานที่สะสมในหน้าต่างปัจจุบัน
    lastT: 0,
    lastP: 0,
    monthKey: '',
    monthPeakKw: 0,
    monthPeakAt: 0,
    todayPeakKw: 0,
    todayKey: '',
    recentWindows: [], // หน้าต่างที่ปิดไปแล้ว เก็บไว้ดูย้อนหลัง
  };
}

/**
 * ป้อนค่ากำลังไฟ ณ เวลาหนึ่งเข้าไป
 * @param prev สถานะ demand เดิม
 * @param t    เวลา (epoch ms)
 * @param p    กำลังไฟที่ซื้อจากการไฟฟ้า ณ ตอนนั้น (kW) ค่าลบถือเป็น 0 (ขายไฟออกไม่นับเป็น demand)
 * @param cfg  ค่าตั้ง
 */
export function feedDemand(prev, t, p, cfg) {
  const d = { ...prev, recentWindows: [...(prev.recentWindows || [])] };
  const power = Math.max(0, p);
  const closed = [];

  // ขึ้นเดือนใหม่ = พีคเริ่มนับใหม่ (นี่คือจุดที่โล่งอกได้เดือนละครั้ง)
  const mk = monthKey(t);
  if (d.monthKey !== mk) {
    d.monthKey = mk;
    d.monthPeakKw = 0;
    d.monthPeakAt = 0;
  }

  const gapMin = d.lastT ? (t - d.lastT) / 60000 : Infinity;

  if (!d.winStart || gapMin > MAX_GAP_MIN || t < d.lastT) {
    // เริ่มใหม่: ข้อมูลขาดช่วงยาว เดาพลังงานที่หายไปไม่ได้
    d.winStart = windowStart(t);
    d.energyKwh = power * ((t - d.winStart) / 3600000); // ประมาณย้อนหลังจากค่าปัจจุบัน
  } else {
    // เดินสะสมพลังงานจากจุดเดิมมาถึงตอนนี้ ถ้าข้ามขอบหน้าต่างให้ตัดแบ่งให้ถูก
    let curT = d.lastT;
    let curP = d.lastP;
    let guard = 0;

    while (curT < t && guard++ < 64) {
      const winEnd = d.winStart + WINDOW_MIN * 60000;
      const stepEnd = Math.min(t, winEnd);
      const spanMs = t - d.lastT;
      // ประมาณกำลังไฟที่ปลายช่วงย่อยแบบเชิงเส้น (สี่เหลี่ยมคางหมู)
      const pAtEnd = spanMs > 0 ? curP + (power - curP) * ((stepEnd - curT) / spanMs) : power;
      d.energyKwh += ((curP + pAtEnd) / 2) * ((stepEnd - curT) / 3600000);
      curT = stepEnd;
      curP = pAtEnd;

      if (stepEnd >= winEnd) {
        const avgKw = d.energyKwh / WINDOW_H;
        closed.push({ start: d.winStart, avgKw });
        d.recentWindows.push({ t: d.winStart, avgKw: Math.round(avgKw * 10) / 10 });
        d.winStart = winEnd;
        d.energyKwh = 0;
      }
    }
  }

  d.lastT = t;
  d.lastP = power;
  d.recentWindows = d.recentWindows.filter((w) => w.t >= t - 26 * 60 * 60 * 1000).slice(-120);

  // อัปเดตพีคจากหน้าต่างที่เพิ่งปิด — พีคนับจากหน้าต่างที่ "จบแล้ว" เท่านั้น เหมือนที่การไฟฟ้าคิด
  const todayKey = `${thTime(t).year}-${thTime(t).month}-${thTime(t).day}`;
  if (d.todayKey !== todayKey) {
    d.todayKey = todayKey;
    d.todayPeakKw = 0;
  }
  for (const w of closed) {
    if (w.avgKw > d.monthPeakKw) {
      d.monthPeakKw = w.avgKw;
      d.monthPeakAt = w.start;
    }
    if (w.avgKw > d.todayPeakKw) d.todayPeakKw = w.avgKw;
  }

  return { demand: d, closed, window: windowView(d, t, power, cfg) };
}

/**
 * มุมมองของหน้าต่างปัจจุบัน — ตัวเลขชุดนี้คือหัวใจของการตัดสินใจ
 *
 *   avgSoFarKw    เฉลี่ยที่ทำไปแล้วในหน้าต่างนี้
 *   projectedKw   ถ้าใช้ไฟเท่านี้ต่อจนจบหน้าต่าง จะจบที่เท่าไหร่
 *   allowedRestKw ที่เหลือของหน้าต่างนี้ ใช้ได้เฉลี่ยไม่เกินกี่ kW ถึงจะไม่เกินเป้า
 *   blown         หน้าต่างนี้เกินเป้าไปแล้ว ต่อให้ปิดทุกอย่างก็ไม่ทัน
 */
export function windowView(d, t, powerNow, cfg) {
  const elapsedH = Math.max(0, (t - d.winStart) / 3600000);
  const remainH = Math.max(0, WINDOW_H - elapsedH);
  const budgetKwh = cfg.demandTargetKw * WINDOW_H;
  const limitKwh = cfg.demandLimitKw * WINDOW_H;

  const avgSoFarKw = elapsedH > 0 ? d.energyKwh / elapsedH : powerNow;
  const projectedKw = (d.energyKwh + powerNow * remainH) / WINDOW_H;
  const allowedRestKw = remainH > 0 ? (budgetKwh - d.energyKwh) / remainH : 0;
  const allowedRestHardKw = remainH > 0 ? (limitKwh - d.energyKwh) / remainH : 0;

  return {
    start: d.winStart,
    elapsedMin: Math.round(elapsedH * 60),
    remainMin: Math.round(remainH * 60),
    energyKwh: d.energyKwh,
    avgSoFarKw,
    projectedKw,
    allowedRestKw,
    allowedRestHardKw,
    blown: allowedRestKw < 0,
    hardBlown: allowedRestHardKw < 0,
  };
}

/** เหลือระยะห่างเท่าไหร่ก่อนโดนย้ายประเภท */
export function monthHeadroom(d, cfg) {
  const peak = d.monthPeakKw || 0;
  return {
    peakKw: peak,
    peakAt: d.monthPeakAt || 0,
    limitKw: cfg.demandLimitKw,
    headroomKw: cfg.demandLimitKw - peak,
    usedPct: Math.min(100, Math.round((peak / cfg.demandLimitKw) * 100)),
    breached: peak >= cfg.demandLimitKw, // เดือนนี้โดนไปแล้ว
    monthKey: d.monthKey,
  };
}
