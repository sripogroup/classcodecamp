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
import { emptyState, evaluate } from './analyze.js';
import { buildDailySummary, buildMessage } from './messages.js';
import { sendTelegram, setTelegramWebhook } from './notify/telegram.js';
import { sendEmail } from './notify/email.js';
import { dashboardHtml } from './dashboard.js';
import { hhmm, minutesBetween, round1, thDateKey } from './util.js';

const STATE_KEY = 'state';
const STALE_MINUTES = 20; // ไม่ได้ข้อมูลนานเกินนี้ = ถือว่าระบบเงียบ

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

      if (path === '/api/history') {
        const state = await readState(env);
        return json({ samples: (state.samples || []).map((s) => ({ t: s.t, pv: r(s.pv), grid: r(s.grid), load: r(s.load) })) });
      }

      // เรียกรอบเก็บข้อมูลเองเพื่อทดสอบ (ดูผลเป็น JSON)
      if (path === '/api/poll') return json(await poll(env, cfg));

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

  if (!cfg.fusionUser || !cfg.fusionPass) {
    return { ok: false, error: 'ยังไม่ได้ตั้ง FUSION_USER / FUSION_SYSTEM_CODE' };
  }

  let reading;
  try {
    reading = await new FusionSolar(cfg, env.SOLAR_KV).readNow();
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
    const state = { ...prev, lastError: { at: now, message: 'ไม่พบมิเตอร์ (Smart Power Sensor) ในระบบ — วัดไฟที่ซื้อจากการไฟฟ้าไม่ได้' } };
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

  const { state, events, cause, demand15, actions } = evaluate(prev, sample, cfg, now);
  state.dayPvKwh = reading.dayPvKwh;
  state.cause = cause.text;
  state.actions = actions;
  state.demand15 = round1(demand15);

  const sent = [];
  for (const ev of events) {
    const msg = buildMessage(ev, cfg, now);
    if (!msg) continue;
    const tg = await sendTelegram(cfg, msg.telegram, { toBoss: !!msg.toBoss, silent: msg.priority === 'low' });
    let mail = { skipped: 'ไม่ส่งอีเมลสำหรับเหตุการณ์นี้' };
    // อีเมลเก็บไว้เฉพาะเรื่องใหญ่ ไม่งั้นคนจะชินแล้วเลิกอ่าน
    if (msg.priority === 'high' && msg.emailSubject) mail = await sendEmail(cfg, msg.emailSubject, msg.emailHtml);
    sent.push({ type: ev.type, telegram: tg.ok, email: !!mail.ok });
  }

  await writeState(env, state);
  return { ok: true, sample, level: state.level, cause: cause.text, demand15: round1(demand15), sent };
}

/* ---------------------------------------------------------------- สรุปประจำวัน */

async function dailySummary(env, cfg) {
  const now = Date.now();
  const state = await readState(env);
  const msg = buildDailySummary(state, cfg, now);
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
    await sendTelegram(cfg, `🔕 ปิดเสียงเตือน ${mins} นาที (โดย ${escapeTg(name)})`, { silent: true });
    return json({ ok: true });
  }

  if (cmd === '/status' || cmd === '/สถานะ') {
    const s = state.samples?.[state.samples.length - 1];
    const icon = { green: '🟢 ปกติ', yellow: '🟡 เฝ้าระวัง', red: '🔴 ต้องลดโหลด' }[state.level] || '⚪ ไม่มีข้อมูล';
    const body = s
      ? `${icon}\nดึงไฟหลวง <b>${round1(s.grid)} kW</b> | โซลาร์ ${round1(s.pv)} kW | โหลด ${round1(s.load)} kW\nข้อมูลเมื่อ ${hhmm(s.t)} น.`
      : `${icon}\nยังไม่มีข้อมูล`;
    await sendTelegram(cfg, body, { silent: true });
    return json({ ok: true });
  }

  if (cmd === '/help' || cmd === '/start') {
    await sendTelegram(
      cfg,
      `🤖 <b>คำสั่งที่ใช้ได้</b>\n/status — ดูสถานะตอนนี้\n/ack — แจ้งว่ารับเรื่องแล้ว (หยุดเตือนซ้ำ ${cfg.ackSuppressMin} นาที)\n/mute 60 — ปิดเสียงเตือนชั่วคราว (นาที)`,
      { silent: true },
    );
    return json({ ok: true });
  }

  return json({ ok: true });
}

/* ---------------------------------------------------------------- ตัวช่วย */

async function readState(env) {
  const raw = await env.SOLAR_KV.get(STATE_KEY, 'json');
  return raw ? { ...emptyState(), ...raw } : emptyState();
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

  return {
    level: stale ? 'unknown' : state.level,
    stale,
    siren: !stale && state.level === 'red', // ให้ ESP32 อ่านค่านี้ไปสั่งไฟหมุน
    gridImportKw: last ? last.grid : null,
    pvKw: last ? last.pv : null,
    loadKw: last ? last.load : null,
    coveragePct,
    dayPvKwh: state.dayPvKwh ?? null,
    demand15: state.demand15 ?? null,
    peakToday: state.peakToday || null,
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

function escapeTg(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
