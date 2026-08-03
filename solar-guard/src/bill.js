/**
 * คำนวณค่าไฟจริงตามบิล PEA — วันนี้ และ ทั้งเดือน
 *
 * อ้างอิงจากบิลจริงเลขที่ 871006112454 รอบ 07/2569 (แรงดัน 22-33 kV, อัตรา TOU):
 *
 *   ค่าความต้องการพลังไฟฟ้า  Peak 25.09 kW x 132.9300      =  3,335.21
 *   ค่าความต้องการพลังไฟฟ้า  Off Peak 20.76 kW x 0.0000    =      0.00   <-- ฟรี
 *   ค่าพลังงานไฟฟ้า          Peak 1,703.91 kWh x 4.1839    =  7,128.99
 *   ค่าพลังงานไฟฟ้า          Off Peak 1,014.90 kWh x 2.6037 =  2,642.50
 *   ค่าบริการรายเดือน                                       =    312.24
 *                                                    รวม    = 13,418.94
 *   Ft 2,718.81 kWh x 0.1623                                =    441.26
 *                                                 รวมย่อย   = 13,860.20
 *   VAT 7%                                                  =    970.21
 *                                                  รวมสุทธิ = 14,830.41
 *
 * สองเรื่องที่ต้องเข้าใจก่อนอ่านโค้ดนี้:
 *
 * 1) ค่าความต้องการพลังไฟฟ้า (demand charge) คิดจาก **ค่าเฉลี่ย 15 นาทีสูงสุดของเดือน
 *    เฉพาะช่วง on-peak เท่านั้น** ช่วง off-peak คิดที่ 0 บาท/kW ตามบิลข้างบน
 *    แปลว่าการกดพีคลงได้ 1 kW ในช่วง on-peak = ประหยัด 132.93 บาท/เดือน (ก่อน VAT)
 *    ส่วนพีคตอนกลางคืนหรือวันอาทิตย์ ไม่มีผลกับค่าไฟส่วนนี้เลย
 *
 * 2) ตัวเลขที่ได้จากไฟล์นี้เป็น **ค่าประมาณ** ไม่ใช่บิลจริง เพราะเราคิดจากการอ่าน
 *    กำลังไฟทุกไม่กี่นาทีแล้วอินทิเกรตเอง ไม่ได้อ่านจากมิเตอร์ของการไฟฟ้า
 *    ถ้าข้อมูลขาดช่วง (เครื่องอ่านปิด) ตัวเลขจะ **ต่ำกว่าความจริง** เสมอ
 *    จึงเก็บ missedMin ไว้ด้วย เพื่อให้หน้าจอบอกได้ว่าตัวเลขนี้เชื่อได้แค่ไหน
 */

import { monthKey } from './demand.js';
import { isTouOnPeak, thDateKey } from './util.js';

const WINDOW_MS = 15 * 60 * 1000;

/** หน้าต่าง 15 นาทีตามหน้าปัดนาฬิกา (00-15, 15-30, 30-45, 45-60) */
function windowStart(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

export function emptyBill(now = Date.now()) {
  return {
    monthKey: monthKey(now),
    dayKey: thDateKey(now),
    since: now, // เริ่มนับเมื่อไหร่ — ใช้บอกว่าตัวเลขครอบคลุมแค่ไหน
    lastT: 0,
    lastKw: 0,
    month: { onPeakKwh: 0, offPeakKwh: 0, demandKw: 0, demandAt: 0, missedMin: 0 },
    day: { onPeakKwh: 0, offPeakKwh: 0, missedMin: 0 },
    win: { start: 0, kwh: 0, coveredMs: 0 },
  };
}

/**
 * ป้อนค่าที่อ่านได้เข้าไปหนึ่งจุด แล้วคืน state ใหม่
 *
 * @param prev   state เดิม
 * @param now    เวลาของค่าที่อ่านได้ (epoch ms)
 * @param gridKw กำลังไฟที่ซื้อจากการไฟฟ้า ณ ขณะนั้น (kW) ค่าติดลบ = ขายออก นับเป็น 0
 */
export function feedBill(prev, now, gridKw, cfg) {
  const b = prev && prev.lastT !== undefined ? clone(prev) : emptyBill(now);
  const kw = Math.max(0, Number(gridKw) || 0);

  // ---- ข้ามเดือน / ข้ามวัน ต้องล้างถังก่อนบวกของใหม่ ----
  const mk = monthKey(now);
  const dk = thDateKey(now);
  if (b.monthKey !== mk) {
    b.monthKey = mk;
    b.since = now;
    b.month = { onPeakKwh: 0, offPeakKwh: 0, demandKw: 0, demandAt: 0, missedMin: 0 };
    b.win = { start: 0, kwh: 0, coveredMs: 0 };
  }
  if (b.dayKey !== dk) {
    b.dayKey = dk;
    b.day = { onPeakKwh: 0, offPeakKwh: 0, missedMin: 0 };
  }

  // จุดแรกสุด ยังไม่มีช่วงเวลาให้อินทิเกรต แค่จำค่าไว้
  if (!b.lastT) {
    b.lastT = now;
    b.lastKw = kw;
    return b;
  }

  const dtMs = now - b.lastT;
  if (dtMs <= 0) return b; // ข้อมูลย้อนเวลา (ยิงซ้ำ) — ไม่นับ

  const maxGapMs = cfg.billMaxGapMin * 60000;
  if (dtMs > maxGapMs) {
    // ขาดข้อมูลนานเกินกว่าจะเดาได้ว่าระหว่างนั้นใช้ไฟเท่าไหร่
    // เดาไม่ได้ก็ไม่เดา — บันทึกไว้ว่าขาดไปเท่าไหร่แล้วข้ามช่วงนี้
    b.month.missedMin += dtMs / 60000;
    b.day.missedMin += dtMs / 60000;
    b.lastT = now;
    b.lastKw = kw;
    b.win = { start: windowStart(now), kwh: 0, coveredMs: 0 };
    return b;
  }

  // ---- อินทิเกรตพลังงาน โดยตัดช่วงตามขอบหน้าต่าง 15 นาที ----
  //
  // ต้องตัดตรงขอบ ไม่ใช่โยนพลังงานทั้งก้อนเข้าหน้าต่างที่ค่าล่าสุดตกอยู่
  // ถ้าไม่ตัด พลังงานของนาทีท้าย ๆ หน้าต่างนี้จะไหลไปโผล่หน้าต่างถัดไป
  // ทำให้ค่าเฉลี่ย 15 นาทีเพี้ยน ซึ่งแพงมากเพราะคิดเงินกันที่ 132.93 บาท/kW
  //
  // 09:00 กับ 22:00 ตกลงบนขอบหน้าต่างพอดี (15 นาทีหารลงตัวกับชั่วโมง)
  // หน้าต่างหนึ่งจึงอยู่ในช่วง on-peak หรือ off-peak ทั้งอัน ไม่มีคาบเกี่ยว
  // การตัดตามหน้าต่างจึงแยก on-peak/off-peak ให้ถูกต้องไปในตัว
  let segStart = b.lastT;
  while (segStart < now) {
    const ws = windowStart(segStart);
    const segEnd = Math.min(now, ws + WINDOW_MS);
    const segMs = segEnd - segStart;

    // กำลังไฟ ณ หัวและท้ายของช่วงย่อย ได้จากการลากเส้นตรงระหว่างสองจุดที่อ่านได้จริง
    const kwA = b.lastKw + (kw - b.lastKw) * ((segStart - b.lastT) / dtMs);
    const kwB = b.lastKw + (kw - b.lastKw) * ((segEnd - b.lastT) / dtMs);
    const segKwh = ((kwA + kwB) / 2) * (segMs / 3600000);

    if (isTouOnPeak(cfg, ws)) {
      b.month.onPeakKwh += segKwh;
      b.day.onPeakKwh += segKwh;
    } else {
      b.month.offPeakKwh += segKwh;
      b.day.offPeakKwh += segKwh;
    }

    if (b.win.start !== ws) {
      closeWindow(b, cfg);
      b.win = { start: ws, kwh: 0, coveredMs: 0 };
    }
    b.win.kwh += segKwh;
    b.win.coveredMs += segMs;

    segStart = segEnd;
  }

  b.lastT = now;
  b.lastKw = kw;
  return b;
}

/**
 * ปิดหน้าต่าง 15 นาทีแล้วเทียบกับพีคของเดือน
 *
 * หารด้วย "เวลาที่มีข้อมูลจริง" ไม่ใช่ 15 นาทีเต็ม — ถ้าหน้าต่างไหนเก็บข้อมูลได้แค่
 * ครึ่งเดียวแล้วเอาไปหาร 15 นาที ค่าเฉลี่ยจะต่ำกว่าความจริงครึ่งหนึ่ง ซึ่งอันตราย
 * เพราะจะบอกว่าปลอดภัยทั้งที่ไม่ปลอดภัย
 */
function closeWindow(b, cfg) {
  const w = b.win;
  if (!w.start || w.coveredMs < cfg.billMinWindowMin * 60000) return;
  if (!isTouOnPeak(cfg, w.start)) return; // off-peak คิดค่า demand ที่ 0 บาท ไม่ต้องเก็บ

  const avgKw = w.kwh / (w.coveredMs / 3600000);
  if (avgKw > b.month.demandKw) {
    b.month.demandKw = avgKw;
    b.month.demandAt = w.start;
  }
}

/**
 * แปลงพลังงานที่สะสมไว้เป็นเงิน ตามโครงสร้างบิล PEA
 *
 * @param scope 'month' คิดครบทุกรายการ | 'day' คิดเฉพาะค่าพลังงาน
 *              (ค่า demand กับค่าบริการเป็นรายเดือน หารเป็นรายวันไม่ได้)
 */
/**
 * @param knownPeakKw พีค 15 นาทีของเดือนที่ระบบรู้จากทางอื่น (ตัวติดตาม demand)
 *
 * มีเพราะตัวคิดค่าไฟเริ่มนับตอนที่มันถูกเปิดใช้ ส่วนตัวติดตาม demand มีข้อมูล
 * ตั้งแต่ต้นเดือน — เดือนที่ย้ายระบบกลางคัน ตัวคิดเงินจะไม่เห็นพีคที่เกิดก่อนหน้า
 * แล้วบอกค่าไฟต่ำกว่าจริงหลายร้อยบาท ซึ่งอันตรายกว่าบอกสูงเกิน เพราะทำให้
 * ชะล่าใจว่ายังไม่ชนเพดาน (เจอจริง 4 ส.ค. 69: บิลใช้ 10.4 kW ทั้งที่พีคจริง 13.4)
 */
export function billView(b, cfg, scope = 'month', knownPeakKw = 0, knownPeakAt = 0) {
  const src = scope === 'day' ? b.day : b.month;
  const onPeakKwh = src.onPeakKwh || 0;
  const offPeakKwh = src.offPeakKwh || 0;
  const totalKwh = onPeakKwh + offPeakKwh;

  const energyOn = onPeakKwh * cfg.tariffBaseOnPeak;
  const energyOff = offPeakKwh * cfg.tariffBaseOffPeak;
  const energy = energyOn + energyOff;
  const ft = totalKwh * cfg.ftPerKwh;
  const ownDemandKw = b.month.demandKw || 0;
  const useKnown = scope === 'month' && (Number(knownPeakKw) || 0) > ownDemandKw;
  const demandKw = scope === 'month' ? Math.max(ownDemandKw, Number(knownPeakKw) || 0) : 0;
  // เวลาต้องมาคู่กับค่าเสมอ ถ้าใช้พีคจากตัวติดตามก็ต้องใช้เวลาของตัวนั้นด้วย
  // ไม่งั้นหน้าจอจะบอกว่า "13.3 kW เมื่อ 3 ส.ค. 15:15" ทั้งที่ 13.3 เกิดวันที่ 1
  const demandAtOut = scope !== 'month' ? 0 : (useKnown ? (Number(knownPeakAt) || 0) : (b.month.demandAt || 0));
  const demand = demandKw * cfg.demandChargePerKw;
  const service = scope === 'month' ? cfg.serviceCharge : 0;

  const subTotal = energy + ft + demand + service;
  const vat = subTotal * (cfg.vatPct / 100);

  return {
    scope,
    onPeakKwh: r2(onPeakKwh),
    offPeakKwh: r2(offPeakKwh),
    totalKwh: r2(totalKwh),
    demandKw: r2(demandKw),
    demandAt: demandAtOut,
    energyBaht: r2(energy),
    energyOnBaht: r2(energyOn),
    energyOffBaht: r2(energyOff),
    ftBaht: r2(ft),
    demandBaht: r2(demand),
    serviceBaht: r2(service),
    vatBaht: r2(vat),
    totalBaht: r2(subTotal + vat),
    missedMin: Math.round(src.missedMin || 0),
    since: b.since || 0,
    // ประหยัดได้เท่าไหร่ถ้ากดพีค on-peak ลงได้อีก 1 kW (รวม VAT แล้ว)
    perKwBaht: r2(cfg.demandChargePerKw * (1 + cfg.vatPct / 100)),
  };
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clone = (o) => JSON.parse(JSON.stringify(o));
