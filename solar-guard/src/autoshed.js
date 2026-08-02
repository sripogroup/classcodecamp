/**
 * ตัวสั่งตัดโหลดอัตโนมัติ (Load Shedding / Demand Control)
 *
 * เป้าหมายเดียว: ห้ามให้ค่าเฉลี่ย 15 นาที แตะ 30 kW แม้แต่ครั้งเดียวในเดือน
 *
 * กฎความปลอดภัยที่ยอมไม่ได้ (คอมเพรสเซอร์แอร์พังง่ายกว่าที่คิด):
 *   - ปิดแล้วต้องปิดค้างอย่างน้อย MIN_OFF นาที ห้ามเปิด-ปิดถี่ (short cycling)
 *   - เปิดกลับแล้วต้องเปิดค้างอย่างน้อย MIN_ON นาที ก่อนจะโดนสั่งปิดอีก
 *   - ปิดต่อเนื่องได้ไม่เกิน MAX_OFF นาที แล้วต้องหมุนเวียนไปปิดโซนอื่นแทน (คนจะได้ไม่ร้อนอยู่โซนเดียว)
 *   - โซนที่ตั้ง protected ไว้ (ห้องเซิร์ฟเวอร์ / ห้องคุมเครื่อง) ห้ามแตะเด็ดขาด
 *   - เปิดกลับทีละโซน ไม่เปิดพร้อมกันหมด (กันกระชากตอนสตาร์ทพร้อมกันจนพีคใหม่)
 *   - โหมด dryrun: คิดครบทุกอย่างแต่ไม่สั่งจริง เอาไว้ดูก่อนว่ามันจะทำอะไร
 */

import { minutesBetween, round1 } from './util.js';

export function emptyShedState() {
  return { zones: {}, lastRestoreAt: 0, shedMinutesToday: 0, dayKey: '' };
}

function zoneState(shed, id) {
  return shed.zones[id] || { off: false, changedAt: 0, reason: '', count: 0 };
}

/**
 * ตัดสินใจว่าจะปิด/เปิดโซนไหนบ้าง
 *
 * @param shed   สถานะการตัดโหลดเดิม
 * @param ctx    { powerNow, projectedKw, allowedRestKw, remainMin, monthPeakKw, breached, paused }
 * @param cfg    ค่าตั้ง
 * @returns { actions: [{id,name,to:'off'|'on',reason,kw}], needKw, shedState, desired }
 */
export function decideShed(shed, ctx, cfg, now = Date.now()) {
  const state = { ...shed, zones: { ...shed.zones } };
  const zones = cfg.zones || [];
  const actions = [];

  if (cfg.autoshedMode === 'off' || !zones.length) {
    return { actions: [], needKw: 0, shedState: state, desired: desiredMap(state, zones), reason: 'ปิดการทำงานอยู่' };
  }

  // ---- ถอย: เดือนนี้เกินเพดานไปแล้ว หรือคนสั่งพักระบบไว้ ----
  // ถ้าเดือนนี้ชนเพดานไปแล้ว การปิดแอร์ต่อไม่ช่วยเรื่องประเภทผู้ใช้ไฟอีกแล้ว
  // (เริ่มนับใหม่เดือนหน้า) ปล่อยให้คนได้ใช้แอร์ตามปกติ ไม่ใช่ทรมานเขาฟรี ๆ ทั้งเดือน
  if (ctx.breached || ctx.paused) {
    const reason = ctx.breached ? 'เดือนนี้เกินเพดานไปแล้ว ตัดต่อไม่ช่วยอะไร' : 'คนสั่งพักระบบไว้';
    for (const z of zones) {
      const zs = zoneState(state, z.id);
      if (!zs.off) continue;
      if (minutesBetween(now, zs.changedAt) < cfg.autoshedMinOffMin) continue; // ยังต้องกันคอมเพรสเซอร์อยู่
      if (minutesBetween(now, state.lastRestoreAt || 0) < cfg.autoshedRestoreGapMin) break;
      state.zones[z.id] = { ...zs, off: false, changedAt: now, reason };
      state.lastRestoreAt = now;
      actions.push({ id: z.id, name: z.name, kw: z.kw, to: 'on', reason });
      break; // เปิดกลับทีละโซนเหมือนเดิม
    }
    return { actions, needKw: 0, shedState: state, desired: desiredMap(state, zones), reason };
  }

  // ---- ต้องตัดกี่ kW ----
  // ถ้าหน้าต่างยังเหลือเวลาพอ ใช้ "เพดานเฉลี่ยของเวลาที่เหลือ" เป็นตัวตั้ง แม่นกว่าใช้ค่า projected เฉย ๆ
  const byRemaining = ctx.remainMin >= 2 ? ctx.powerNow - ctx.allowedRestKw : 0;
  const byProjection = ctx.projectedKw - cfg.demandTargetKw;
  const over = Math.max(byRemaining, byProjection);
  const armed = ctx.projectedKw >= cfg.demandActionKw || ctx.powerNow >= cfg.demandActionKw;
  const needKw = armed ? Math.max(0, over + cfg.shedMarginKw) : 0;

  const currentlyOff = zones.filter((z) => zoneState(state, z.id).off);
  const shedNowKw = currentlyOff.reduce((a, z) => a + (Number(z.kw) || 0), 0);

  // ---- 1) หมุนเวียนโซนที่ปิดนานเกินกำหนด ----
  for (const z of currentlyOff) {
    const zs = zoneState(state, z.id);
    if (minutesBetween(now, zs.changedAt) >= cfg.autoshedMaxOffMin) {
      state.zones[z.id] = { ...zs, off: false, changedAt: now, reason: 'ปิดครบเวลาแล้ว หมุนเวียนไปโซนอื่น' };
      actions.push({ id: z.id, name: z.name, kw: z.kw, to: 'on', reason: `ปิดครบ ${cfg.autoshedMaxOffMin} นาที หมุนเวียน` });
    }
  }

  // ---- 2) ยังต้องตัดเพิ่มไหม ----
  const stillOff = zones.filter((z) => zoneState(state, z.id).off);
  let remaining = needKw - stillOff.reduce((a, z) => a + (Number(z.kw) || 0), 0);

  if (remaining > 0) {
    const candidates = zones
      .filter((z) => !z.protected)
      .filter((z) => !zoneState(state, z.id).off)
      .filter((z) => {
        const zs = zoneState(state, z.id);
        // เพิ่งเปิดกลับ ยังไม่ครบเวลาขั้นต่ำ อย่าเพิ่งปิดซ้ำ
        return !zs.changedAt || minutesBetween(now, zs.changedAt) >= cfg.autoshedMinOnMin;
      })
      // ปิดตัวที่ priority น้อยก่อน (กระทบคนน้อยสุด) ถ้าเท่ากันเอาตัวที่ตัดได้เยอะก่อน
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || Number(b.kw) - Number(a.kw));

    const maxZones = cfg.autoshedMaxZones || zones.length;
    for (const z of candidates) {
      if (remaining <= 0) break;
      if (zones.filter((x) => zoneState(state, x.id).off).length >= maxZones) break;
      state.zones[z.id] = { ...zoneState(state, z.id), off: true, changedAt: now, count: zoneState(state, z.id).count + 1 };
      actions.push({ id: z.id, name: z.name, kw: z.kw, to: 'off', reason: `ตัดโหลดกันเกิน ${cfg.demandLimitKw} kW` });
      remaining -= Number(z.kw) || 0;
    }
  }

  // ---- 3) ปลอดภัยแล้ว เปิดกลับทีละโซน ----
  const safe = ctx.projectedKw <= cfg.demandRestoreKw && ctx.powerNow <= cfg.demandRestoreKw;
  if (safe && needKw <= 0) {
    const offNow = zones
      .filter((z) => zoneState(state, z.id).off)
      // เปิดคืนตัวที่สำคัญที่สุดก่อน (priority มากสุด = ตัวที่ยอมปิดเป็นตัวท้าย ๆ)
      .sort((a, b) => (b.priority ?? 99) - (a.priority ?? 99));

    for (const z of offNow) {
      const zs = zoneState(state, z.id);
      if (minutesBetween(now, zs.changedAt) < cfg.autoshedMinOffMin) continue; // กันคอมเพรสเซอร์พัง
      if (minutesBetween(now, state.lastRestoreAt || 0) < cfg.autoshedRestoreGapMin) break; // เปิดทีละตัว
      state.zones[z.id] = { ...zs, off: false, changedAt: now, reason: 'กลับสู่ปกติ' };
      state.lastRestoreAt = now;
      actions.push({ id: z.id, name: z.name, kw: z.kw, to: 'on', reason: 'ไฟลงมาปลอดภัยแล้ว' });
      break; // เปิดรอบละ 1 โซนเท่านั้น
    }
  }

  return { actions, needKw: round1(needKw), shedState: state, desired: desiredMap(state, zones), shedNowKw: round1(shedNowKw) };
}

/** สถานะที่ "ควรจะเป็น" ของทุกโซน — ตัวควบคุมในโรงงานดึงอันนี้ไปสั่งรีเลย์ */
export function desiredMap(shed, zones) {
  const out = {};
  for (const z of zones) {
    const zs = zoneState(shed, z.id);
    out[z.id] = {
      name: z.name,
      kw: z.kw,
      power: zs.off ? 'off' : 'on',
      since: zs.changedAt || 0,
      protected: !!z.protected,
    };
  }
  return out;
}
