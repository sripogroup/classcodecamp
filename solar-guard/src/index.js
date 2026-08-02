/**
 * Solar Guard — เฝ้าระวังการใช้ไฟจากระบบโซลาร์ Huawei FusionSolar
 * รันบน Cloudflare Workers (แพ็กฟรี) ไม่ต้องมีเครื่องเซิร์ฟเวอร์ ไม่ต้องรัน Node ค้างไว้
 *
 * Cron (ตั้งไว้ใน wrangler.toml):
 *   ทุก 5 นาที      -> ดึงข้อมูล + ประเมิน + แจ้งเตือน
 *   "30 10 * * *"  -> 17:30 น. เวลาไทย ส่งสรุปประจำวัน
 */

import { loadConfig } from './config.js';
import { FusionSolar } from './fusionsolar.js';
import { emptyState, evaluate, evaluateDemand, pickActions } from './analyze.js';
import { emptyDemand, feedDemand, monthHeadroom, windowView } from './demand.js';
import { decideShed, desiredMap, emptyShedState } from './autoshed.js';
import { checkSchedule, emptyScheduleState } from './schedule.js';
import { applyZone } from './drivers/index.js';
import { fetchKiosk, flattenNumbers, guessFields, kioskApiUrl, readNowFromKiosk } from './kiosk.js';
import { buildDailySummary, buildMessage } from './messages.js';
import { sendTelegram, setTelegramWebhook } from './notify/telegram.js';
import { sendEmail } from './notify/email.js';
import { dashboardHtml } from './dashboard.js';
import { hhmm, minutesBetween, round1, thDateKey } from './util.js';

const STATE_KEY = 'state';
const STALE_MINUTES = 20; // ไม่ได้ข้อมูลนานเกินนี้ = ถือว่าระบบเงียบ

/** ชนิดอุปกรณ์ของ FusionSolar เท่าที่เกี่ยวกับระบบนี้ ใช้ตอน /api/probe-devices */
const DEV_TYPE_NAMES = {
  1: 'อินเวอร์เตอร์ (String inverter)',
  2: 'SmartLogger',
  10: 'เครื่องวัดสภาพอากาศ (EMI)',
  17: 'มิเตอร์ (Grid meter)',
  38: 'อินเวอร์เตอร์บ้าน (Residential inverter)',
  39: 'แบตเตอรี่',
  41: 'ระบบกักเก็บพลังงาน (ESS)',
  46: 'ออปติไมเซอร์',
  47: 'มิเตอร์อัจฉริยะ (Smart Power Sensor)',
  62: 'ดองเกิล',
};

export default {
  async fetch(request, env, ctx) {
    const cfg = loadConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/telegram/webhook' && request.method === 'POST') {
        return handleTelegramWebhook(request, env, cfg);
      }

      if (cfg.dashboardToken) {
        const given = url.searchParams.get('k') || request.headers.get('x-token') || '';
        if (given !== cfg.dashboardToken) return new Response('ไม่มีสิทธิ์เข้าถึง', { status: 401 });
      }

      if (path === '/' || path === '/index.html') {
        return new Response(dashboardHtml(cfg, cfg.dashboardToken), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      if (path === '/api/state') return json(await publicState(env, cfg));

      // ตัวควบคุมในโรงงาน (ESP32 / Shelly) ดึงอันนี้ไปสั่งรีเลย์เอง
      // Cloudflare Workers เรียกเข้า LAN ไม่ได้ จึงต้องให้ฝั่งโรงงานเป็นคนถามเข้ามา
      if (path === '/api/zones') {
        const state = await readState(env);
        const last = state.samples?.[state.samples.length - 1];
        const stale = !last || minutesBetween(Date.now(), last.t) > STALE_MINUTES;
        return json({
          // ⚠️ ถ้า stale = true ตัวควบคุมต้องเปิดทุกโซนกลับ (fail-safe)
          // ระบบเงียบต้องไม่แปลว่า "ปิดแอร์ค้างไว้ต่อไป"
          stale,
          mode: cfg.autoshedMode,
          updatedAt: last ? last.t : null,
          zones: stale ? allOn(cfg) : desiredMap(state.shed || emptyShedState(), cfg.zones || []),
        });
      }

      if (path === '/api/history') {
        const state = await readState(env);
        return json({ samples: (state.samples || []).map((s) => ({ t: s.t, pv: r(s.pv), grid: r(s.grid), load: r(s.load) })) });
      }

      // เรียกรอบเก็บข้อมูลเองเพื่อทดสอบ (ดูผลเป็น JSON)
      if (path === '/api/poll') return json(await poll(env, cfg));

      // ส่องดูอุปกรณ์ทั้งหมดในระบบ พร้อมค่าดิบทุกฟิลด์ที่ FusionSolar ส่งกลับมา
      // เรียกครั้งเดียวหลัง deploy จะรู้ทันทีว่ามิเตอร์อยู่ที่ devTypeId ไหน ชื่อฟิลด์อะไร
      // ไม่ต้องเดา ไม่ต้องไล่แก้ทีละรอบ
      if (path === '/api/probe-devices') {
        try {
          const fs = new FusionSolar(cfg, env.SOLAR_KV);
          const stationCode = await fs.resolveStationCode();
          const devices = await fs.getDevices(stationCode);

          const byType = new Map();
          for (const d of devices) {
            const t = Number(d.devTypeId);
            if (!byType.has(t)) byType.set(t, []);
            byType.get(t).push(d);
          }

          const out = [];
          for (const [devTypeId, list] of byType) {
            let kpi = null;
            let error = null;
            try {
              kpi = await fs.call('getDevRealKpi', {
                devIds: list.map((d) => String(d.id ?? d.devId)).join(','),
                devTypeId,
              });
            } catch (err) {
              error = String(err?.message || err);
            }
            out.push({
              devTypeId,
              คืออะไร: DEV_TYPE_NAMES[devTypeId] || 'ไม่ทราบชนิด',
              อุปกรณ์: list.map((d) => ({ id: d.id ?? d.devId, name: d.devName, esn: d.esnCode })),
              ค่าที่อ่านได้: (kpi || []).map((r) => r.dataItemMap),
              error,
            });
          }

          const meterTypes = out.filter((o) => [17, 47].includes(o.devTypeId));
          return json({
            ok: true,
            stationCode,
            สรุป: {
              พบอุปกรณ์: out.map((o) => `${o.คืออะไร} (devTypeId=${o.devTypeId}) x${o.อุปกรณ์.length}`),
              มีมิเตอร์ไหม: meterTypes.length
                ? `✅ มี — ${meterTypes.map((m) => m.คืออะไร).join(', ')} ใช้ระบบนี้ได้`
                : '⚠️ ไม่พบอุปกรณ์ชนิดมิเตอร์ในรายการ ดูช่อง "ค่าที่อ่านได้" ว่ามีฟิลด์ไหนบอกกำลังไฟฝั่งการไฟฟ้าไหม',
              ขั้นตอนถัดไป: 'ดู active_power ของมิเตอร์ เทียบกับตัวเลข Current power ในหน้า Overview ว่าตรงกันและเครื่องหมายถูกทางไหม',
            },
            devices: out,
          });
        } catch (err) {
          return json({ ok: false, error: String(err?.message || err) }, 502);
        }
      }

      // ส่องดูว่า Kiosk View ให้ข้อมูลอะไรมาบ้างจริง ๆ
      // มีไว้ตอบคำถามเดียว: "มีข้อมูลฝั่งซื้อไฟ/โหลดรวมด้วยไหม"
      // ถ้ามี = ใช้ Kiosk แทนบัญชี Northbound API ได้เลย ถ้าไม่มี = ต้องใช้ Northbound API
      if (path === '/api/probe-kiosk') {
        const key = url.searchParams.get('kk') || cfg.kioskKey;
        if (!key) return json({ ok: false, error: 'ยังไม่ได้ใส่ KIOSK_KEY (หรือส่งมาทาง ?kk=)' }, 400);

        try {
          const probeCfg = { ...cfg, kioskKey: key };
          const { data } = await fetchKiosk(probeCfg);
          const flat = flattenNumbers(data);
          const guess = guessFields(flat);
          return json({
            ok: true,
            url: kioskApiUrl(probeCfg),
            สรุป: {
              พบตัวเลขทั้งหมด: Object.keys(flat).length,
              น่าจะเป็นฝั่งผลิต: guess.pv,
              น่าจะเป็นฝั่งซื้อไฟ: guess.grid,
              น่าจะเป็นโหลดรวม: guess.load,
              ใช้ระบบนี้ได้ไหม:
                guess.grid.length || guess.load.length
                  ? '✅ น่าจะได้ — ดูค่าในตาราง fields ว่าตรงกับความจริงไหม แล้วตั้ง KIOSK_FIELD_MAP'
                  : '❌ ไม่มีข้อมูลฝั่งใช้ไฟ ต้องใช้บัญชี Northbound API แทน',
            },
            fields: flat,
            rawKeys: data && typeof data === 'object' ? Object.keys(data) : [],
          });
        } catch (err) {
          return json({ ok: false, error: String(err?.message || err) }, 502);
        }
      }

      // ส่งข้อความทดสอบเข้ากลุ่ม เอาไว้เช็คว่าตั้ง Telegram ถูกไหม
      if (path === '/api/test-alert') {
        const tg = await sendTelegram(cfg, `🧪 <b>ทดสอบระบบแจ้งเตือน</b>\n${cfg.siteName} • ${hhmm()} น.\nถ้าเห็นข้อความนี้ แปลว่าตั้งค่าถูกแล้วครับ`);
        const mail = await sendEmail(cfg, `🧪 ทดสอบระบบแจ้งเตือน ${cfg.siteName}`, '<p>ถ้าเห็นอีเมลนี้ แปลว่าตั้งค่าถูกแล้วครับ</p>');
        return json({ telegram: tg, email: mail });
      }

      // ตั้ง webhook ให้บอทรับคำสั่ง /ack (เรียกครั้งเดียวหลัง deploy)
      if (path === '/api/setup-webhook') {
        return json(await setTelegramWebhook(cfg, url.origin));
      }

      return new Response('ไม่พบหน้านี้', { status: 404 });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const cfg = loadConfig(env);
    if (event.cron === '30 10 * * *') ctx.waitUntil(dailySummary(env, cfg));
    else ctx.waitUntil(poll(env, cfg));
  },
};

/* ---------------------------------------------------------------- รอบเก็บข้อมูล */

async function poll(env, cfg) {
  const now = Date.now();
  const prev = await readState(env);

  const useKiosk = cfg.dataSource === 'kiosk';
  if (useKiosk ? !cfg.kioskKey : !cfg.fusionUser || !cfg.fusionPass) {
    return { ok: false, error: useKiosk ? 'ยังไม่ได้ตั้ง KIOSK_KEY' : 'ยังไม่ได้ตั้ง FUSION_USER / FUSION_SYSTEM_CODE' };
  }

  let reading;
  try {
    reading = useKiosk ? await readNowFromKiosk(cfg) : await new FusionSolar(cfg, env.SOLAR_KV).readNow();
  } catch (err) {
    const state = { ...prev, lastError: { at: now, message: String(err?.message || err) } };
    // เงียบมานานผิดปกติ -> บอกให้รู้ครั้งเดียว จะได้ไม่เข้าใจผิดว่า "ไม่มีข้อความ = ไม่มีปัญหา"
    if (prev.lastOkAt && minutesBetween(now, prev.lastOkAt) >= 60 && minutesBetween(now, prev.lastSilenceAlertAt || 0) >= 180) {
      state.lastSilenceAlertAt = now;
      await sendTelegram(
        cfg,
        `⚠️ <b>ระบบเฝ้าระวังดึงข้อมูลไม่ได้</b>\nไม่ได้รับข้อมูลจาก FusionSolar มา ${Math.round(minutesBetween(now, prev.lastOkAt))} นาที\nสาเหตุ: ${escapeTg(state.lastError.message)}\n\n<i>ช่วงนี้ระบบจะไม่เตือนเรื่องการใช้ไฟ ให้เฝ้าเองไปก่อนครับ</i>`,
      );
    }
    await writeState(env, state);
    return { ok: false, error: state.lastError.message };
  }

  if (!reading.meterFound || reading.gridImportKw === null) {
    const why = useKiosk
      ? 'Kiosk View ไม่ได้ให้ข้อมูลฝั่งซื้อไฟ/โหลดรวม — เรียก /api/probe-kiosk เพื่อดูว่ามีฟิลด์อะไรบ้าง'
      : 'ไม่พบมิเตอร์ (Smart Power Sensor) ในระบบ — วัดไฟที่ซื้อจากการไฟฟ้าไม่ได้';
    const state = { ...prev, lastError: { at: now, message: why } };
    await writeState(env, state);
    return { ok: false, error: state.lastError.message };
  }

  const sample = {
    t: now,
    pv: round1(reading.pvKw),
    grid: round1(reading.gridImportKw),
    load: round1(reading.loadKw),
    bat: round1(reading.batteryKw),
  };

  // ---- 1) คิดค่า demand ตามหน้าต่าง 15 นาทีของการไฟฟ้า ----
  const demandRes = feedDemand(prev.demand || emptyDemand(), now, sample.grid, cfg);
  const headroom = monthHeadroom(demandRes.demand, cfg, demandRes.window.projectedKw);

  // ---- 2) สายที่หนึ่ง: เตือนคนเรื่องค่าไฟ (มีการหน่วงเวลากันเตือนหลอก) ----
  const { state, events, cause, demand15, actions } = evaluate(prev, sample, cfg, now);
  state.demand = demandRes.demand;
  state.dayPvKwh = reading.dayPvKwh;
  state.cause = cause.text;
  state.actions = actions;
  state.demand15 = round1(demand15);
  state.window = demandRes.window;
  state.headroom = headroom;

  // ---- 3) สายที่สอง: ป้องกันเพดานการไฟฟ้า (ไม่หน่วงเวลา) ----
  const prevDemandAlertAt = prev.lastDemandAlertAt || 0;
  const demandEval = evaluateDemand(
    state,
    { window: demandRes.window, headroom, closed: demandRes.closed, sample },
    cfg,
    now,
  );
  Object.assign(state, demandEval.state);

  // ข้อความเรื่องเพดานมีตัวเลขและรายการที่ต้องไปปิดครบกว่าสายค่าไฟอยู่แล้ว
  // ถ้ากำลังอยู่ในช่วงเตือนเรื่องเพดาน ให้สายค่าไฟเงียบไปเลย — ไม่ใช่แค่รอบนี้
  // ไม่งั้นรอบนี้ได้ข้อความเพดาน อีก 5 นาทีได้ข้อความค่าไฟที่บอกเรื่องเดียวกันซ้ำอีกใบ
  const hasDemandAlert = demandEval.events.some((e) => e.type === 'demand_risk');
  const demandAlertRecently = minutesBetween(now, prevDemandAlertAt) < cfg.repeatMin;
  const comfortEvents =
    hasDemandAlert || demandAlertRecently ? events.filter((e) => !['alert', 'repeat'].includes(e.type)) : events;

  // รายการที่ให้คนไปปิดสำหรับข้อความสายเพดาน ต้องคิดจาก "ส่วนที่เกินเป้า demand"
  // ห้ามใช้ actions ของสายค่าไฟ เพราะสายนั้นยังหน่วงเวลาอยู่ ตอนเตือนรอบแรกมันจะยังเป็นลิสต์ว่าง
  // แล้วข้อความที่ด่วนที่สุดจะออกไปโดยไม่บอกใครว่าต้องทำอะไร
  const demandActions = pickActions(cfg, Math.max(0, demandRes.window.projectedKw - cfg.demandTargetKw));

  // ---- 3.5) งานประจำที่ต้องทำทุกวัน (เช่น ปิดแอร์ 15:00) ----
  // ใช้ samples ของรอบก่อนหน้าเป็นฐาน เพราะ state.samples รอบนี้มี sample ปัจจุบันรวมอยู่แล้ว
  const sched = checkSchedule(prev.schedule || emptyScheduleState(), sample, prev.samples || [], cfg, now);
  state.schedule = sched.state;

  const allEvents = [
    ...comfortEvents,
    ...demandEval.events.map((e) => ({ ...e, actions: demandActions })),
    ...sched.events,
  ];

  // ---- 4) ตัดโหลดอัตโนมัติ ----
  const shedRes = decideShed(
    prev.shed || emptyShedState(),
    {
      powerNow: sample.grid,
      projectedKw: demandRes.window.projectedKw,
      allowedRestKw: demandRes.window.allowedRestKw,
      remainMin: demandRes.window.remainMin,
      monthPeakKw: headroom.peakKw,
      breached: headroom.breached,
      paused: now < (state.shedPauseUntil || 0),
    },
    cfg,
    now,
  );
  state.shed = shedRes.shedState;

  const applied = [];
  if (shedRes.actions.length && cfg.autoshedMode !== 'off') {
    const dryRun = cfg.autoshedMode === 'dryrun';
    for (const a of shedRes.actions) {
      const zone = (cfg.zones || []).find((z) => z.id === a.id);
      applied.push({ ...a, result: zone ? await applyZone(zone, a.to === 'on', dryRun) : { ok: false, error: 'ไม่พบโซน' } });
    }
    const offs = shedRes.actions.filter((a) => a.to === 'off');
    allEvents.push({
      type: offs.length ? 'shed' : 'restore',
      changes: shedRes.actions,
      window: demandRes.window,
      headroom,
      sample,
      dryRun,
    });
  }

  // ---- 5) ส่งข้อความ ----
  const sent = [];
  for (const ev of allEvents) {
    const msg = buildMessage(ev, cfg, now);
    if (!msg) continue;
    const tg = await sendTelegram(cfg, msg.telegram, { toBoss: !!msg.toBoss, silent: msg.priority === 'low' });
    let mail = { skipped: 'ไม่ส่งอีเมลสำหรับเหตุการณ์นี้' };
    // อีเมลเก็บไว้เฉพาะเรื่องใหญ่ ไม่งั้นคนจะชินแล้วเลิกอ่าน
    if (msg.priority === 'high' && msg.emailSubject) mail = await sendEmail(cfg, msg.emailSubject, msg.emailHtml);
    sent.push({ type: ev.type, telegram: tg.ok, email: !!mail.ok });
  }

  await writeState(env, state);
  return {
    ok: true,
    sample,
    level: state.level,
    cause: cause.text,
    window: {
      elapsedMin: demandRes.window.elapsedMin,
      remainMin: demandRes.window.remainMin,
      avgSoFarKw: round1(demandRes.window.avgSoFarKw),
      projectedKw: round1(demandRes.window.projectedKw),
      allowedRestKw: round1(demandRes.window.allowedRestKw),
    },
    monthPeakKw: round1(headroom.peakKw),
    headroomKw: round1(headroom.headroomKw),
    autoshed: { mode: cfg.autoshedMode, needKw: shedRes.needKw, actions: applied },
    sent,
  };
}

/* ---------------------------------------------------------------- สรุปประจำวัน */

async function dailySummary(env, cfg) {
  const now = Date.now();
  const state = await readState(env);
  const msg = buildDailySummary(state, cfg, now, monthHeadroom(state.demand || emptyDemand(), cfg));
  if (!msg) return { ok: false, error: 'ยังไม่มีข้อมูลของวันนี้' };

  await sendTelegram(cfg, msg.telegram, { silent: true });
  await sendEmail(cfg, msg.emailSubject, msg.emailHtml);

  // เก็บสรุปของวันไว้ 60 วัน แล้วรีเซ็ตค่าพีคของวัน
  await env.SOLAR_KV.put(`day:${thDateKey(now)}`, JSON.stringify({ peakToday: state.peakToday, samples: state.samples }), {
    expirationTtl: 60 * 24 * 60 * 60,
  });
  await writeState(env, { ...state, peakToday: { kw: 0, at: 0 } });
  return { ok: true };
}

/* ---------------------------------------------------------------- คำสั่งใน Telegram */

async function handleTelegramWebhook(request, env, cfg) {
  if (cfg.telegramWebhookSecret) {
    const got = request.headers.get('x-telegram-bot-api-secret-token');
    if (got !== cfg.telegramWebhookSecret) return new Response('ไม่มีสิทธิ์', { status: 401 });
  }

  const update = await request.json().catch(() => null);
  const text = (update?.message?.text || '').trim();
  const from = update?.message?.from;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'พนักงาน';
  if (!text) return json({ ok: true });

  const state = await readState(env);
  const now = Date.now();
  const cmd = text.split(/[\s@]/)[0].toLowerCase();

  if (cmd === '/ack' || cmd === '/รับทราบ') {
    await writeState(env, { ...state, ackAt: now, ackBy: name });
    await sendTelegram(cfg, `👍 รับทราบแล้วโดย <b>${escapeTg(name)}</b> — ระบบจะหยุดเตือนซ้ำ ${cfg.ackSuppressMin} นาที\nถ้าไฟหลวงยังเข้าหนักหลังจากนั้น จะเตือนใหม่อีกครั้ง`, { silent: true });
    return json({ ok: true });
  }

  if (cmd === '/mute') {
    const mins = Math.min(240, Math.max(5, Number(text.split(/\s+/)[1]) || 60));
    await writeState(env, { ...state, mutedUntil: now + mins * 60000 });
    await sendTelegram(
      cfg,
      `🔕 ปิดเสียงเตือนเรื่องค่าไฟ ${mins} นาที (โดย ${escapeTg(name)})\n\n<i>หมายเหตุ: การเตือนเรื่องเพดาน ${cfg.demandLimitKw} kW ยังทำงานอยู่ตามปกติ — ปิดไม่ได้ เพราะพลาดครั้งเดียวผูกยาว 12 เดือน</i>`,
      { silent: true },
    );
    return json({ ok: true });
  }

  // แจ้งว่าทำงานประจำเรียบร้อยแล้ว (เผื่อระบบวัดโหลดไม่ทัน หรือปิดอย่างอื่นแทน)
  if (cmd === '/done' || cmd === '/ปิดแล้ว') {
    const schedule = { ...(state.schedule || emptyScheduleState()), tasks: { ...(state.schedule?.tasks || {}) } };
    const pending = Object.entries(schedule.tasks).filter(([, t]) => !t.done && !t.gaveUp);
    for (const [id, t] of pending) schedule.tasks[id] = { ...t, done: true, doneAt: now, doneBy: name };
    await writeState(env, { ...state, schedule });
    await sendTelegram(
      cfg,
      pending.length
        ? `✅ รับทราบว่า${pending.map(([id]) => escapeTg((cfg.dailyTasks || []).find((t) => t.id === id)?.name || id)).join(', ')} เรียบร้อยแล้ว (โดย ${escapeTg(name)})\n\n<i>ระบบจะหยุดย้ำ แต่ยังเฝ้าเรื่องเพดาน ${cfg.demandLimitKw} kW ให้ตามปกติ</i>`
        : `ตอนนี้ไม่มีงานที่ค้างอยู่ครับ`,
      { silent: true },
    );
    return json({ ok: true });
  }

  // เปิดอุปกรณ์ที่ระบบสั่งปิดไว้กลับมาทั้งหมด (คนสั่งชนะระบบเสมอ)
  if (cmd === '/restore' || cmd === '/เปิดกลับ') {
    const zones = cfg.zones || [];
    const offZones = zones.filter((z) => state.shed?.zones?.[z.id]?.off);
    const shed = { ...(state.shed || emptyShedState()), zones: { ...(state.shed?.zones || {}) } };
    for (const z of offZones) {
      shed.zones[z.id] = { ...shed.zones[z.id], off: false, changedAt: now, reason: `เปิดกลับโดย ${name}` };
      if (cfg.autoshedMode === 'on') await applyZone(z, true, false);
    }
    // พักเฉพาะ "การสั่งปิดอัตโนมัติ" 30 นาที — ไม่ใช่ปิดปากการเตือนเพดาน
    // (ถ้าไปตั้ง mutedUntil ตรงนี้ จะกลายเป็นว่ากด /restore แล้วระบบเงียบเรื่อง 30 kW ไปด้วย ซึ่งอันตราย)
    await writeState(env, { ...state, shed, shedPauseUntil: now + 30 * 60000 });
    await sendTelegram(
      cfg,
      offZones.length
        ? `✅ เปิดกลับ ${offZones.length} โซนแล้ว (โดย ${escapeTg(name)})\n${offZones.map((z) => `• ${escapeTg(z.name)}`).join('\n')}\n\n<i>ระบบจะไม่สั่งปิดอัตโนมัติอีก 30 นาที</i>`
        : `ตอนนี้ไม่มีโซนไหนถูกสั่งปิดอยู่ครับ`,
      { silent: true },
    );
    return json({ ok: true });
  }

  if (cmd === '/status' || cmd === '/สถานะ') {
    const s = state.samples?.[state.samples.length - 1];
    const icon = { green: '🟢 ปกติ', yellow: '🟡 เฝ้าระวัง', red: '🔴 ต้องลดโหลด' }[state.level] || '⚪ ไม่มีข้อมูล';
    const w = state.window;
    const h = monthHeadroom(state.demand || emptyDemand(), cfg, w?.projectedKw || 0);
    const offZones = (cfg.zones || []).filter((z) => state.shed?.zones?.[z.id]?.off);
    const body = s
      ? [
          icon,
          `ดึงไฟหลวง <b>${round1(s.grid)} kW</b> | โซลาร์ ${round1(s.pv)} kW | โหลด ${round1(s.load)} kW`,
          w ? `⏱ หน้าต่างนี้เหลือ ${w.remainMin} นาที คาดจบที่ <b>${round1(w.projectedKw)} kW</b>` : '',
          `📅 พีคเดือนนี้ <b>${round1(h.livePeakKw)} kW</b> / เพดาน ${h.limitKw} kW — เหลือระยะ ${round1(h.headroomKw)} kW`,
          offZones.length ? `⛔ ถูกสั่งปิดอยู่: ${offZones.map((z) => escapeTg(z.name)).join(', ')}` : '',
          `ข้อมูลเมื่อ ${hhmm(s.t)} น.`,
        ]
          .filter(Boolean)
          .join('\n')
      : `${icon}\nยังไม่มีข้อมูล`;
    await sendTelegram(cfg, body, { silent: true });
    return json({ ok: true });
  }

  if (cmd === '/help' || cmd === '/start') {
    await sendTelegram(
      cfg,
      `🤖 <b>คำสั่งที่ใช้ได้</b>\n/status — ดูสถานะตอนนี้ + พีคของเดือน\n/done — แจ้งว่าปิดแอร์ตามรอบแล้ว\n/ack — แจ้งว่ารับเรื่องแล้ว (หยุดเตือนซ้ำ ${cfg.ackSuppressMin} นาที)\n/restore — เปิดอุปกรณ์ที่ระบบสั่งปิดกลับทั้งหมด\n/mute 60 — ปิดเสียงเตือนชั่วคราว (นาที)`,
      { silent: true },
    );
    return json({ ok: true });
  }

  return json({ ok: true });
}

/* ---------------------------------------------------------------- ตัวช่วย */

async function readState(env) {
  const raw = await env.SOLAR_KV.get(STATE_KEY, 'json');
  const base = { ...emptyState(), demand: emptyDemand(), shed: emptyShedState(), schedule: emptyScheduleState() };
  return raw ? { ...base, ...raw } : base;
}

async function writeState(env, state) {
  await env.SOLAR_KV.put(STATE_KEY, JSON.stringify(state));
}

/** สถานะที่หน้าจอ / ไฟหมุน (ESP32) เอาไปใช้ได้ */
async function publicState(env, cfg) {
  const state = await readState(env);
  const last = state.samples?.[state.samples.length - 1] || null;
  const stale = !last || minutesBetween(Date.now(), last.t) > STALE_MINUTES;
  const coveragePct = last && last.load > 0 ? Math.round(((last.load - Math.max(0, last.grid)) / last.load) * 100) : null;
  const demand = state.demand || emptyDemand();
  // คิดหน้าต่างใหม่ ณ เวลาที่เรียก เพื่อให้ตัวเลข "เหลืออีกกี่นาที" ตรงกับความจริง
  const win = last && !stale ? windowView(demand, Date.now(), last.grid, cfg) : state.window || null;
  const headroom = monthHeadroom(demand, cfg, win && !stale ? win.projectedKw : 0);

  return {
    level: stale ? 'unknown' : state.level,
    stale,
    siren: !stale && state.level === 'red', // ให้ ESP32 อ่านค่านี้ไปสั่งไฟหมุน
    gridImportKw: last ? last.grid : null,
    pvKw: last ? last.pv : null,
    loadKw: last ? last.load : null,
    coveragePct,
    dayPvKwh: state.dayPvKwh ?? null,
    peakToday: state.peakToday || null,

    // ---- ตัวเลขชุดที่สำคัญที่สุด: เพดานการไฟฟ้า ----
    demand: win
      ? {
          elapsedMin: win.elapsedMin,
          remainMin: win.remainMin,
          avgSoFarKw: r(win.avgSoFarKw),
          projectedKw: r(win.projectedKw),
          allowedRestKw: r(win.allowedRestKw),
          blown: win.blown,
        }
      : null,
    month: {
      peakKw: r(headroom.livePeakKw), // ตัวที่เอาไปโชว์ (รวมหน้าต่างที่กำลังเดินอยู่)
      lockedPeakKw: r(headroom.peakKw), // ตัวที่ล็อกแล้วจากหน้าต่างที่ปิดไปแล้ว
      liveIsCurrent: headroom.liveIsCurrent,
      peakAt: headroom.peakAt,
      limitKw: headroom.limitKw,
      headroomKw: r(headroom.headroomKw),
      usedPct: headroom.usedPct,
      breached: headroom.breached,
      monthKey: headroom.monthKey,
    },
    todayPeakKw: r(demand.todayPeakKw || 0),
    autoshed: {
      mode: cfg.autoshedMode,
      offZones: (cfg.zones || []).filter((z) => state.shed?.zones?.[z.id]?.off).map((z) => ({ id: z.id, name: z.name, kw: z.kw })),
    },
    targets: { warnKw: cfg.warnKw, critKw: cfg.critKw, actionKw: cfg.demandActionKw, targetKw: cfg.demandTargetKw },
    cause: state.cause || null,
    actions: state.level === 'green' ? [] : state.actions || [],
    ackBy: state.ackBy || null,
    mutedUntil: state.mutedUntil || 0,
    warnKw: cfg.warnKw,
    critKw: cfg.critKw,
    updatedAt: last ? last.t : null,
    lastError: state.lastError?.message || null,
  };
}

const r = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

/** ทุกโซนเปิด — ใช้เป็นค่า fail-safe เวลาระบบไม่มีข้อมูลสด */
function allOn(cfg) {
  const out = {};
  for (const z of cfg.zones || []) out[z.id] = { name: z.name, kw: z.kw, power: 'on', since: 0, protected: !!z.protected };
  return out;
}

function escapeTg(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
