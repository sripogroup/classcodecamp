/** ตัวช่วยเรื่องเวลา (ไทย = UTC+7 ตลอดปี ไม่มี DST) และตัวเลข */

export const TH_OFFSET_MS = 7 * 60 * 60 * 1000;

/** แปลง epoch ms -> ชิ้นส่วนเวลาไทย */
export function thTime(ts = Date.now()) {
  const d = new Date(ts + TH_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(), // 0 = อาทิตย์
  };
}

/** "13:45" */
export function hhmm(ts = Date.now()) {
  const t = thTime(ts);
  return `${pad(t.hour)}:${pad(t.minute)}`;
}

/** "2026-08-02" ตามวันที่ไทย */
export function thDateKey(ts = Date.now()) {
  const t = thTime(ts);
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}

const TH_MONTH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** "3 ส.ค. 13:45" — สั้นพอที่จะแปะท้ายบรรทัดในแชทได้โดยไม่ตัดบรรทัด */
export function thWhen(ts) {
  if (!ts) return '–';
  const t = thTime(ts);
  return `${t.day} ${TH_MONTH_SHORT[t.month - 1]} ${pad(t.hour)}:${pad(t.minute)}`;
}

export function thDateThai(ts = Date.now()) {
  const t = thTime(ts);
  return `${t.day} ${TH_MONTH_SHORT[t.month - 1]} ${t.year + 543}`;
}

export const pad = (n) => String(n).padStart(2, '0');

/** อยู่ในเวลาทำงานไหม */
export function isWorkTime(cfg, ts = Date.now()) {
  const t = thTime(ts);
  return cfg.workDays.includes(t.dow) && t.hour >= cfg.workStartHour && t.hour < cfg.workEndHour;
}

/** ช่วงกลางคืน (คร่อมเที่ยงคืนได้) */
export function isNight(cfg, ts = Date.now()) {
  const h = thTime(ts).hour;
  return cfg.nightStartHour > cfg.nightEndHour
    ? h >= cfg.nightStartHour || h < cfg.nightEndHour
    : h >= cfg.nightStartHour && h < cfg.nightEndHour;
}

/** ช่วงแดดแรง ใช้เช็คว่าอินเวอร์เตอร์ยังทำงานอยู่ไหม */
export function isPeakSun(cfg, ts = Date.now()) {
  const h = thTime(ts).hour;
  return h >= cfg.sunStartHour && h < cfg.sunEndHour;
}

/** อัตราค่าไฟ ณ เวลานั้น (TOU: On Peak จ-ศ 09:00-22:00) */
export function tariffNow(cfg, ts = Date.now()) {
  if (!cfg.useTou) return cfg.tariffOnPeak;
  const t = thTime(ts);
  const weekday = t.dow >= 1 && t.dow <= 5;
  const onPeak = weekday && t.hour >= 9 && t.hour < 22;
  return onPeak ? cfg.tariffOnPeak : cfg.tariffOffPeak;
}

export function isTouOnPeak(cfg, ts = Date.now()) {
  const t = thTime(ts);
  return t.dow >= 1 && t.dow <= 5 && t.hour >= 9 && t.hour < 22;
}

/**
 * ช่วงท้ายของ on-peak ที่อันตรายที่สุดของวัน (ค่าเริ่มต้น 15:00-22:00 จันทร์-ศุกร์)
 *
 * ทำไมช่วงนี้ถึงอันตราย: แดดเริ่มตกแต่โรงงานยังเดินเครื่องอยู่ โซลาร์ที่เคยแบกโหลด
 * ให้ 20 kW เหลือไม่กี่ kW ส่วนที่หายไปกลายเป็นไฟหลวงทันทีโดยไม่มีใครทำอะไรผิด
 * และยังอยู่ในช่วง on-peak ซึ่งเป็นช่วงเดียวที่การไฟฟ้าคิดค่าความต้องการพลังไฟฟ้า
 * พีคที่เกิดตรงนี้จึงแพงที่สุด — ต้องเฝ้าเข้มกว่าเวลาอื่น
 *
 * ผูกกับ isTouOnPeak ไว้ เสาร์-อาทิตย์จึงไม่เข้าเงื่อนไขเอง (ไม่มีค่า demand อยู่แล้ว)
 */
export function isEveningWatch(cfg, ts = Date.now()) {
  if (!isTouOnPeak(cfg, ts)) return false;
  return thTime(ts).hour >= cfg.eveningWatchHour;
}

/**
 * อยู่ในเวลาที่ยอมให้รบกวนกลุ่มพนักงานไหม (ค่าเริ่มต้น 08:00–19:00)
 *
 * นอกช่วงนี้ระบบยังทำงานและยังส่งข้อความเหมือนเดิมทุกอย่าง เปลี่ยนแค่ปลายทาง
 * เป็นหัวหน้าคนเดียว การเงียบสนิทไม่ใช่ทางเลือก เพราะช่วง on-peak ยาวถึง 22:00
 * พีคที่เกิดตอนสองทุ่มคิดเงินเท่าพีคตอนบ่ายทุกบาท
 */
export function isStaffHours(cfg, ts = Date.now()) {
  const h = thTime(ts).hour;
  const a = cfg.staffHourStart ?? 8;
  const b = cfg.staffHourEnd ?? 19;
  if (a === b) return true; // ตั้งเท่ากัน = ไม่จำกัดเวลา
  return a < b ? h >= a && h < b : h >= a || h < b;
}

export const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const minutesBetween = (a, b) => Math.abs(a - b) / 60000;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * ช่วงที่เครื่องอ่านในโรงงานปิดแน่นอน (เช่น ตี 3 ถึง 7 โมงครึ่ง)
 *
 * ช่วงนี้ข้อมูลขาดเป็นเรื่องปกติ ไม่ใช่ความผิดปกติ ถ้าเตือนทุกคืนคนจะชิน
 * แล้วเลิกอ่าน ซึ่งอันตรายกว่าไม่เตือนเลย รองรับค่าที่มีจุดทศนิยม (7.5 = 07:30)
 */
export function isQuietHours(cfg, ts = Date.now()) {
  const t = thTime(ts);
  const h = t.hour + t.minute / 60;
  const a = cfg.quietStartHour;
  const b = cfg.quietEndHour;
  if (a === b) return false;
  return a > b ? h >= a || h < b : h >= a && h < b;
}
