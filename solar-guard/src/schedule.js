/**
 * ตัวเฝ้า "งานประจำที่ต้องทำทุกวัน" — หัวใจของระบบนี้จริง ๆ
 *
 * ที่มา: เหตุการณ์จริงที่ทำให้โดนค่าไฟแพงทั้งปี
 *   พนักงานที่มีหน้าที่ปิดแอร์ตอน 15:00 ลาครึ่งวัน ไม่มีใครปิดแทน
 *   กว่าจะรู้ตัวคือ 20:00 น. — ช้าไป 5 ชั่วโมง
 *
 * ปัญหาไม่ใช่ "ไฟค่อย ๆ ไต่ขึ้นจนเกิน" แต่คือ **งานที่ต้องทำแล้วไม่มีใครทำ**
 * ซึ่งเป็นคนละเรื่องกัน และต้องจับด้วยวิธีคนละแบบ:
 *   - เกณฑ์ kW จับได้ก็ต่อเมื่อมันเกินไปแล้ว
 *   - ตัวนี้จับได้ตั้งแต่ 15:10 ว่า "ยังไม่มีใครไปปิด" ก่อนที่ตัวเลขจะเกิน
 *
 * ⚠️ จุดสำคัญของการออกแบบ: ดูที่ "โหลดรวม" ไม่ใช่ "ไฟที่ซื้อจากการไฟฟ้า"
 * เพราะช่วง 15:00 แดดกำลังตก ต่อให้ปิดแอร์แล้ว ไฟที่ซื้อก็ยังขึ้นได้อยู่ดี
 * ถ้าไปวัดที่ไฟที่ซื้อ จะแยกไม่ออกว่า "ไม่มีใครปิดแอร์" หรือ "แค่แดดหาย"
 * แต่โหลดรวมจะลดลงเมื่อมีคนปิดแอร์เสมอ ไม่ว่าแดดจะเป็นยังไง
 */

import { minutesBetween, round1, thTime } from './util.js';

export function emptyScheduleState() {
  return { tasks: {} };
}

/** เวลา epoch ของ "วันนี้ เวลา HH:MM ตามเวลาไทย" */
export function taskTimeToday(hhmmStr, now) {
  const [h, m] = String(hhmmStr).split(':').map(Number);
  const t = thTime(now);
  // สร้างจากเที่ยงคืนไทยของวันนี้ แล้วบวกชั่วโมง/นาที
  const midnightUtc = Date.UTC(t.year, t.month - 1, t.day, 0, 0, 0) - 7 * 3600000;
  return midnightUtc + (h || 0) * 3600000 + (m || 0) * 60000;
}

const dayKeyOf = (now) => {
  const t = thTime(now);
  return `${t.year}-${t.month}-${t.day}`;
};

/**
 * ค่าโหลดเฉลี่ยก่อนถึงเวลานัด ใช้เป็นฐานเปรียบเทียบ
 * เว้นช่วง 2 นาทีสุดท้ายไว้ เผื่อมีคนไปปิดก่อนเวลานิดหน่อย
 */
export function baselineLoad(samples, taskTs, windowMin = 20) {
  const from = taskTs - windowMin * 60000;
  const to = taskTs - 2 * 60000;
  const win = samples.filter((s) => s.t >= from && s.t <= to && s.load != null);
  if (win.length < 2) return null;
  return win.reduce((a, s) => a + s.load, 0) / win.length;
}

/**
 * ตรวจงานประจำทุกรอบเก็บข้อมูล
 *
 * @returns { state, events }
 */
export function checkSchedule(prevState, sample, samples, cfg, now = Date.now()) {
  const state = { ...prevState, tasks: { ...(prevState.tasks || {}) } };
  const events = [];
  const dayKey = dayKeyOf(now);
  const dow = thTime(now).dow;

  for (const task of cfg.dailyTasks || []) {
    if (!task.at || !task.id) continue;
    const days = Array.isArray(task.days) && task.days.length ? task.days : [1, 2, 3, 4, 5, 6];
    if (!days.includes(dow)) continue;

    // สถานะของงานนี้ในวันนี้ (ขึ้นวันใหม่ = เริ่มนับใหม่)
    let ts = state.tasks[task.id];
    if (!ts || ts.dayKey !== dayKey) {
      ts = { dayKey, done: false, gaveUp: false, alertCount: 0, lastAlertAt: 0, baselineKw: null, ackAt: 0 };
    }

    const taskTs = taskTimeToday(task.at, now);
    const graceMin = Number(task.graceMin) || 10;
    const checkFrom = taskTs + graceMin * 60000;
    const expectDrop = Number(task.expectDropKw) || 0;

    // ยังไม่ถึงเวลาตรวจ — แค่เก็บค่าฐานไว้ก่อน
    if (now < checkFrom) {
      if (ts.baselineKw === null && now >= taskTs - 2 * 60000) {
        ts.baselineKw = baselineLoad(samples || [], taskTs, task.baselineMin || 20);
      }
      state.tasks[task.id] = ts;
      continue;
    }

    if (ts.done || ts.gaveUp) {
      state.tasks[task.id] = ts;
      continue;
    }

    // เผื่อกรณีระบบเพิ่งตื่นมาหลังเลยเวลาไปแล้ว ยังคำนวณค่าฐานย้อนหลังได้
    if (ts.baselineKw === null) ts.baselineKw = baselineLoad(samples || [], taskTs, task.baselineMin || 20);

    // ไม่มีข้อมูลก่อนหน้าพอ = ตัดสินไม่ได้ อย่าเดา อย่าเตือนมั่ว
    if (ts.baselineKw === null) {
      state.tasks[task.id] = ts;
      continue;
    }

    const loadNow = sample.load ?? 0;
    const dropKw = ts.baselineKw - loadNow;
    const overdueMin = Math.round(minutesBetween(now, taskTs));

    if (dropKw >= expectDrop) {
      // ทำแล้ว — บอกให้รู้ครั้งเดียวว่าเรียบร้อย จะได้ไม่ต้องมาเดาว่าระบบทำงานอยู่ไหม
      ts.done = true;
      ts.doneAt = now;
      events.push({
        type: 'task_done',
        task,
        dropKw: round1(dropKw),
        baselineKw: round1(ts.baselineKw),
        loadKw: round1(loadNow),
        overdueMin,
        sample,
      });
    } else if (overdueMin >= (task.giveUpMin || 90)) {
      // เลยเวลามามากแล้ว หยุดย้ำ แต่ต้องสรุปให้รู้ว่าวันนี้ไม่มีใครทำ
      ts.gaveUp = true;
      events.push({
        type: 'task_failed',
        task,
        dropKw: round1(dropKw),
        baselineKw: round1(ts.baselineKw),
        loadKw: round1(loadNow),
        overdueMin,
        sample,
      });
    } else {
      const every = Number(task.repeatMin) || 10;
      const acked = ts.ackAt && minutesBetween(now, ts.ackAt) < 30;
      if (!acked && (!ts.lastAlertAt || minutesBetween(now, ts.lastAlertAt) >= every)) {
        ts.alertCount += 1;
        ts.lastAlertAt = now;
        events.push({
          type: 'task_missed',
          task,
          dropKw: round1(dropKw),
          baselineKw: round1(ts.baselineKw),
          loadKw: round1(loadNow),
          overdueMin,
          attempt: ts.alertCount,
          // เตือนรอบแรกเข้ากลุ่ม รอบที่ 2 เป็นต้นไปตามหัวหน้าด้วย
          // เพราะเคสนี้เกิดจาก "คนที่รับผิดชอบไม่อยู่" การส่งหาคนเดิมซ้ำ ๆ จึงไม่มีประโยชน์
          toBoss: ts.alertCount >= 2,
          sample,
        });
      }
    }

    state.tasks[task.id] = ts;
  }

  return { state, events };
}
