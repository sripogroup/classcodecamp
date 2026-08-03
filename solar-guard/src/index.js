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
import { activeThresholds, emptyState, evaluate, evaluateDemand, pickActions } from './analyze.js';
import { billView, emptyBill, feedBill } from './bill.js';
import { emptyDemand, feedDemand, monthHeadroom, monthKey, windowView } from './demand.js';
import { decideShed, desiredMap, emptyShedState } from './autoshed.js';
import { checkSchedule, emptyScheduleState } from './schedule.js';
import { applyZone } from './drivers/index.js';
import { fetchKiosk, flattenNumbers, guessFields, kioskApiUrl, readNowFromKiosk } from './kiosk.js';
import { buildDailySummary, buildMessage } from './messages.js';
import { setTelegramWebhook, replyTelegram } from './notify/telegram.js';
import { sendChat } from './notify/chat.js';
import { sendEmail } from './notify/email.js';
import { dashboardHtml } from './dashboard.js';
import { hhmm, isQuietHours, isStaffHours, minutesBetween, round1, thDateKey, thWhen } from './util.js';

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

      // ตัวอ่านในโรงงานส่งค่ามาที่นี่ — ไม่ต้องพึ่งคลาวด์ Huawei เลย
      // ข้อมูลสดกว่ามาก (วินาที แทนที่จะเป็น 5-10 นาที) ซึ่งสำคัญกับหน้าต่าง 15 นาที
      //   curl -X POST .../api/ingest -H 'X-Ingest-Token: xxx' \
      //        -d '{"pv":11.9,"grid":1.9}'
      if (path === '/api/ingest' && request.method === 'POST') {
        if (!cfg.ingestToken) return json({ ok: false, error: 'ยังไม่ได้ตั้ง INGEST_TOKEN' }, 400);
        const given = request.headers.get('x-ingest-token') || url.searchParams.get('token') || '';
        if (given !== cfg.ingestToken) return json({ ok: false, error: 'รหัสไม่ถูกต้อง' }, 401);

        const body = await request.json().catch(() => null);
        if (!body) return json({ ok: false, error: 'body ต้องเป็น JSON' }, 400);

        const pv = Number(body.pv);
        const grid = Number(body.grid);
        if (!Number.isFinite(pv) || !Number.isFinite(grid)) {
          return json({ ok: false, error: 'ต้องส่ง pv และ grid มาเป็นตัวเลข (หน่วย kW)' }, 400);
        }

        const load = Number.isFinite(Number(body.load)) ? Number(body.load) : pv + grid;
        return json(
          await poll(env, cfg, {
            source: 'push',
            t: Number.isFinite(Number(body.t)) ? Number(body.t) : Date.now(),
            pvKw: pv,
            gridImportKw: cfg.meterSign * grid,
            loadKw: load,
            batteryKw: Number(body.battery) || 0,
            dayPvKwh: Number.isFinite(Number(body.dayPv)) ? Number(body.dayPv) : null,
            meterFound: true,
          }),
        );
      }

      // เติมข้อมูลย้อนหลังเข้าเครื่องคิดค่าไฟ
      //
      // แยกออกมาจาก /api/ingest โดยตั้งใจ เพราะ ingest จะปลุกระบบแจ้งเตือนทั้งชุด
      // การยิงข้อมูลของเมื่อวานเข้าไปจะทำให้พนักงานได้ข้อความ "ต้องลดโหลด" ของ
      // เหตุการณ์ที่ผ่านไปแล้ว ตรงนี้จึงแตะเฉพาะเครื่องคิดค่าไฟ ไม่แตะสถานะและไม่ส่งอะไรเลย
      //
      // สร้างใหม่จากศูนย์ทุกครั้ง (ไม่ใช่บวกทับของเดิม) เพื่อให้ยิงซ้ำได้โดยยอดไม่บวม
      if (path === '/api/backfill' && request.method === 'POST') {
        if (!cfg.ingestToken) return json({ ok: false, error: 'ยังไม่ได้ตั้ง INGEST_TOKEN' }, 400);
        const given = request.headers.get('x-ingest-token') || url.searchParams.get('token') || '';
        if (given !== cfg.ingestToken) return json({ ok: false, error: 'รหัสไม่ถูกต้อง' }, 401);

        const body = await request.json().catch(() => null);
        const rows = Array.isArray(body?.samples) ? body.samples : null;
        if (!rows || !rows.length) return json({ ok: false, error: 'ต้องส่ง samples เป็นอาร์เรย์' }, 400);

        const clean = rows
          .map((s) => ({ t: Number(s.t), grid: Number(s.grid) }))
          .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.grid))
          .sort((a, b) => a.t - b.t);
        if (!clean.length) return json({ ok: false, error: 'ไม่มีแถวไหนใช้ได้ ต้องมี t และ grid เป็นตัวเลข' }, 400);

        // ทิ้งค่าที่เป็นไปไม่ได้ก่อน ไม่งั้นการสร้างใหม่จะลอกความเสียหายกลับเข้ามาอีกรอบ
        const usable = clean.filter((s) => Math.abs(s.grid) <= cfg.maxPlausibleKw);
        if (!usable.length) return json({ ok: false, error: 'ทุกแถวเกินเพดานความสมเหตุสมผล' }, 400);

        const state = (await readState(env)) || emptyState();

        let droppedSamples = 0;
        let bill = emptyBill(usable[0].t);
        for (const s of usable) bill = feedBill(bill, s.t, cfg.meterSign * s.grid, cfg);
        state.bill = bill;

        // สร้างพีคใหม่จากประวัติจริงด้วย ไม่ใช่แค่ค่าไฟ
        //
        // พีควัน/พีคเดือน/หน้าต่าง 15 นาที เก็บค่าสูงสุดแบบถาวร ถ้าเคยมีค่าขยะหลุดเข้าไป
        // มันจะค้างอยู่จนสิ้นเดือน ลบเองไม่ได้เลย ตรงนี้จึงเป็นทางเดียวที่จะล้างได้
        // ไม่แตะสถานะการเตือน (level/ack/ประวัติการส่ง) เพราะไม่ใช่เรื่องของข้อมูลย้อนหลัง
        if (body.rebuildPeaks) {
          const mk = monthKey(usable[usable.length - 1].t);
          const todayKey = thDateKey(usable[usable.length - 1].t);
          let demand = emptyDemand();
          const mp = { key: mk, gridKw: 0, gridAt: 0, loadKw: 0, loadAt: 0, pvKw: 0, pvAt: 0 };
          let peakToday = { kw: 0, at: 0 };

          for (const s of usable) {
            const g = cfg.meterSign * s.grid;
            if (monthKey(s.t) !== mk) continue;
            demand = feedDemand(demand, s.t, g, cfg).demand;
            if (g > mp.gridKw) { mp.gridKw = g; mp.gridAt = s.t; }
            if (thDateKey(s.t) === todayKey && g > peakToday.kw) peakToday = { kw: round1(g), at: s.t };
          }

          // ล้างจุดขยะออกจากประวัติที่ใช้วาดกราฟด้วย
          //
          // กราฟปรับสเกลแกนตั้งตามค่าสูงสุดที่มีอยู่ จุด 1,279 kW จุดเดียวจึงยืดแกน
          // ไปถึงพันกว่า เส้นจริง 0-25 kW ถูกกดแบนติดขอบล่างจนมองไม่เห็นทั้งกราฟ
          const before = (state.samples || []).length;
          state.samples = (state.samples || []).filter(
            (s) => Math.abs(s.grid ?? 0) <= cfg.maxPlausibleKw
              && Math.abs(s.pv ?? 0) <= cfg.maxPlausibleKw
              && Math.abs(s.load ?? 0) <= cfg.maxPlausibleKw,
          );
          droppedSamples = before - state.samples.length;

          state.demand = demand;
          // โหลดกับโซลาร์ไม่ได้ส่งมากับ backfill จึงเก็บของเดิมไว้ ยกเว้นที่เกินเพดาน
          const old = state.monthPeaks && state.monthPeaks.key === mk ? state.monthPeaks : null;
          state.monthPeaks = {
            ...mp,
            loadKw: old && old.loadKw <= cfg.maxPlausibleKw ? old.loadKw : 0,
            loadAt: old && old.loadKw <= cfg.maxPlausibleKw ? old.loadAt : 0,
            pvKw: old && old.pvKw <= cfg.maxPlausibleKw ? old.pvKw : 0,
            pvAt: old && old.pvKw <= cfg.maxPlausibleKw ? old.pvAt : 0,
          };
          state.peakToday = peakToday;
        }

        await writeState(env, state);

        return json({
          ok: true,
          got: clean.length,
          used: usable.length,
          dropped: clean.length - usable.length,
          rebuiltPeaks: !!body.rebuildPeaks,
          droppedSamples,
          from: usable[0].t,
          to: usable[usable.length - 1].t,
          month: billView(bill, cfg, 'month'),
          monthPeakKw: state.demand ? round1(state.demand.monthPeakKw || 0) : null,
          peakToday: state.peakToday || null,
        });
      }

      // เซิร์ฟเวอร์ในโรงงานบอกว่า "ยังอยู่ดี"
      //
      // ตั้งแต่ย้ายสมองไปอยู่บนเครื่องในโรงงาน หน้าที่ที่เหลือของคลาวด์คือเป็นยาม:
      // คอยฟังสัญญาณนี้ ถ้าขาดหายไปแปลว่าเครื่องนั้นดับ/ไฟดับ/Windows รีสตาร์ทเอง
      // ซึ่งต้องมีใครที่ยัง "อยู่ข้างนอก" เป็นคนบอก ไม่งั้นระบบตายเงียบ
      //
      // 10 นาทีครั้ง = 144 ครั้ง/วัน จากโควตาเขียน KV 1,000 ครั้งของแพ็กฟรี
      if (path === "/api/heartbeat" && request.method === "POST") {
        if (!cfg.ingestToken) return json({ ok: false, error: 'ยังไม่ได้ตั้ง INGEST_TOKEN' }, 400);
        const given = request.headers.get('x-ingest-token') || url.searchParams.get('token') || '';
        if (given !== cfg.ingestToken) return json({ ok: false, error: 'รหัสไม่ถูกต้อง' }, 401);

        const body = (await request.json().catch(() => null)) || {};
        const state = (await readState(env)) || emptyState();
        const prev = state.heartbeat;
        state.heartbeat = {
          at: Date.now(),
          level: body.level ?? null,
          gridImportKw: num(body.gridImportKw),
          pvKw: num(body.pvKw),
          loadKw: num(body.loadKw),
          monthPeakKw: num(body.monthPeakKw),
          emergency: !!body.emergency,
          // ข้อมูลเพิ่มเพื่อให้ /status ในแชทตอบจากของจริงได้ ไม่ใช่ค่าค้างเก่า
          window: body.window ?? null,
          headroom: body.headroom ?? null,
          monthPeaks: body.monthPeaks ?? null,
          billToday: num(body.billToday),
          billMonth: num(body.billMonth),
          nightIdleKw: num(body.nightIdleKw),
        };
        // เคยเตือนว่าเงียบไปแล้ว พอกลับมาต้องล้างธง จะได้เตือนได้อีกถ้าหายไปอีกรอบ
        const wasDown = !!state.localDownNotifiedAt;
        if (wasDown) state.localDownNotifiedAt = 0;

        // เขียน KV เท่าที่จำเป็น — โควตาแพ็กฟรีคือ 1,000 ครั้ง/วัน และวันที่
        // ใช้จนหมด คลาวด์จะไม่รู้เลยว่าเครื่องในโรงงานยังอยู่ แล้วอาจเตือนว่า
        // เครื่องตายทั้งที่ยังทำงานปกติ (เกิดจริง 3 ส.ค. 2569)
        //
        // เขียนเมื่อ: เพิ่งกลับมาจากที่เคยเงียบ / ระดับเปลี่ยน / มีเรื่องฉุกเฉิน
        // นอกนั้นเขียนอย่างช้าทุก 15 นาที
        //
        // 15 ต้องน้อยกว่า localDownMin (25) เสมอ ไม่งั้นคลาวด์จะอ่านเวลาที่ค้าง
        // อยู่ใน KV แล้วสรุปว่าเครื่องในโรงงานตาย ทั้งที่มันส่งสัญญาณมาตรงเวลา
        // — เตือนผิดแบบนี้อันตรายกว่าไม่เตือน เพราะครั้งต่อไปจะไม่มีใครเชื่อ
        const changed = wasDown
          || prev?.level !== state.heartbeat.level
          || state.heartbeat.emergency
          || !prev?.at
          || (Date.now() - prev.at) >= 15 * 60000;

        // เขียนไม่ได้ไม่ใช่ความผิดของเครื่องในโรงงาน — ตอบ ok ไปตามปกติ
        //
        // โควตาเขียนแพ็กฟรีหมดได้จริง (1,000 ครั้ง/วัน รีเซ็ตเที่ยงคืน UTC = 07:00 น.
        // บ้านเรา) ถ้าตอบ 500 เครื่องในโรงงานจะขึ้น WARN รัวทุก 10 นาทีเหมือนตัวเอง
        // ทำอะไรผิด ทั้งที่มันส่งมาถูกต้องทุกอย่าง — บอกไปตรง ๆ ว่าเซฟไม่ได้เพราะอะไร
        // แล้วให้มันตัดสินใจเองว่าจะบอกคนไหม
        let saved = false;
        let saveError = null;
        if (changed) {
          try { await writeState(env, state); saved = true; } catch (err) {
            saveError = String(err?.message || err);
          }
        }
        return json({ ok: true, at: state.heartbeat.at, saved, saveError });
      }

      // ส่งข้อความแทนเซิร์ฟเวอร์ในโรงงาน
      //
      // โทเคนของบอทเป็นความลับที่เก็บไว้บน Cloudflare อย่างเดียว (wrangler secret)
      // อ่านกลับออกมาไม่ได้ตามที่ควรจะเป็น เครื่องในโรงงานจึงส่ง Telegram เองไม่ได้
      // ทางเลือกคือก๊อปโทเคนไปวางไว้บนเครื่องอีกชุด ซึ่งแปลว่ามีความลับสองที่
      // ต้องคอยหมุนพร้อมกัน — ไม่คุ้ม
      //
      // ตรงนี้จึงเป็นแค่ทางผ่าน: **ไม่แตะ KV เลย** จึงไม่กินโควตาเขียน 1,000/วัน
      if (path === '/api/notify' && request.method === 'POST') {
        if (!cfg.ingestToken) return json({ ok: false, error: 'ยังไม่ได้ตั้ง INGEST_TOKEN' }, 400);
        const given = request.headers.get('x-ingest-token') || url.searchParams.get('token') || '';
        if (given !== cfg.ingestToken) return json({ ok: false, error: 'รหัสไม่ถูกต้อง' }, 401);

        const body = (await request.json().catch(() => null)) || {};
        const text = String(body.text || '').slice(0, 4000);
        if (!text) return json({ ok: false, error: 'ต้องส่ง text' }, 400);

        const chat = await sendChat(cfg, text, {
          toBoss: !!body.toBoss,
          silent: !!body.silent,
          bossOnly: !!body.bossOnly, // นอกเวลางาน: หัวหน้าคนเดียว ไม่กวนกลุ่มพนักงาน
        });
        let mail = { skipped: 'ไม่ได้ขอให้ส่งอีเมล' };
        if (body.emailSubject) mail = await sendEmail(cfg, String(body.emailSubject), String(body.emailHtml || text));
        return json({ ok: true, chat, email: mail });
      }

      // LINE ยิง event มาที่นี่
      //
      // เหตุผลหลักตอนนี้: หา groupId ของกลุ่มที่เชิญบอทเข้าไป ซึ่งไม่มีทางรู้
      // จากที่ไหนอีกเลย LINE ไม่มีหน้าจอให้ดู ต้องดักจาก event เท่านั้น
      // ต่อไปใช้รับคำสั่ง /ack จากในกลุ่มได้ด้วย
      //
      // ต้องอยู่เหนือด่าน dashboardToken เพราะ LINE ยิงมาโดยไม่มีโทเคนของเรา
      if (path === '/line/webhook' && request.method === 'POST') {
        const raw = await request.text();

        let verified = null;
        if (cfg.lineChannelSecret) {
          verified = await verifyLineSignature(cfg.lineChannelSecret, raw, request.headers.get('x-line-signature') || '');
          if (!verified) return json({ ok: false, error: 'ลายเซ็นไม่ถูกต้อง' }, 401);
        }

        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }

        const seen = [];
        for (const ev of parsed?.events || []) {
          const s = ev.source || {};
          seen.push({
            sourceType: s.type || '?',
            id: s.groupId || s.roomId || s.userId || '',
            event: ev.type,
            at: ev.timestamp || Date.now(),
          });
        }

        if (seen.length) {
          const prev = JSON.parse((await env.SOLAR_KV.get('line:sources')) || '[]');
          await env.SOLAR_KV.put('line:sources', JSON.stringify([...seen, ...prev].slice(0, 20)));
        }

        // ต้องตอบ 200 เสมอ ไม่งั้น LINE จะปิด webhook ให้เองเมื่อพลาดบ่อย ๆ
        return json({ ok: true, verified, got: seen.length });
      }

      if (cfg.dashboardToken) {
        const given = url.searchParams.get('k') || request.headers.get('x-token') || '';
        if (given !== cfg.dashboardToken) return new Response('ไม่มีสิทธิ์เข้าถึง', { status: 401 });
      }

      // อ่านรายการ source ที่ LINE เคยส่งมา — อยู่หลังด่านโทเคนเพราะเป็นข้อมูลของบัญชี
      if (path === '/api/line-sources') {
        return json(JSON.parse((await env.SOLAR_KV.get('line:sources')) || '[]'));
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

      // ส่งข้อความทดสอบเข้าทุกช่องทางที่ตั้งค่าไว้ เอาไว้เช็คว่าตั้งถูกไหม
      if (path === '/api/test-alert') {
        const chat = await sendChat(cfg, `🧪 <b>ทดสอบระบบแจ้งเตือน</b>\n${cfg.siteName} • ${hhmm()} น.\nถ้าเห็นข้อความนี้ แปลว่าตั้งค่าถูกแล้วครับ`);
        const mail = await sendEmail(cfg, `🧪 ทดสอบระบบแจ้งเตือน ${cfg.siteName}`, '<p>ถ้าเห็นอีเมลนี้ แปลว่าตั้งค่าถูกแล้วครับ</p>');
        return json({ chat, email: mail });
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
    // โหมด push: ตัวอ่านในโรงงานเป็นคนส่งค่าเข้ามาเอง cron มีหน้าที่แค่เฝ้าว่ามันยังส่งอยู่ไหม
    // โหมด local: สมองอยู่บนเครื่องในโรงงาน คลาวด์เหลือหน้าที่เดียวคือเป็นยาม
    else if (cfg.dataSource === 'local') ctx.waitUntil(checkLocalAlive(env, cfg));
    else if (cfg.dataSource === 'push') ctx.waitUntil(checkPushHealth(env, cfg));
    else ctx.waitUntil(poll(env, cfg));
  },
};

/* ---------------------------------------------------------------- รอบเก็บข้อมูล */

async function poll(env, cfg, injected = null) {
  const now = injected?.t || Date.now();
  const prev = await readState(env);

  const useKiosk = cfg.dataSource === 'kiosk';
  if (!injected && (useKiosk ? !cfg.kioskKey : !cfg.fusionUser || !cfg.fusionPass)) {
    return { ok: false, error: useKiosk ? 'ยังไม่ได้ตั้ง KIOSK_KEY' : 'ยังไม่ได้ตั้ง FUSION_USER / FUSION_SYSTEM_CODE' };
  }

  let reading;
  try {
    // โหมด push: ตัวอ่านในโรงงานส่งค่ามาให้แล้ว ไม่ต้องไปดึงจากคลาวด์ Huawei
    reading = injected || (useKiosk ? await readNowFromKiosk(cfg) : await new FusionSolar(cfg, env.SOLAR_KV).readNow());
  } catch (err) {
    const state = { ...prev, lastError: { at: now, message: String(err?.message || err) } };
    // เงียบมานานผิดปกติ -> บอกให้รู้ครั้งเดียว จะได้ไม่เข้าใจผิดว่า "ไม่มีข้อความ = ไม่มีปัญหา"
    // ตี 3 ถึง 7 โมงครึ่ง เครื่องอ่านปิดแน่นอน ขาดข้อมูลช่วงนั้นไม่ใช่ความผิดปกติ
    if (!isQuietHours(cfg, now) && prev.lastOkAt && minutesBetween(now, prev.lastOkAt) >= 60 && minutesBetween(now, prev.lastSilenceAlertAt || 0) >= 180) {
      state.lastSilenceAlertAt = now;
      await sendChat(
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

  // ---- ด่านกันค่าที่เป็นไปไม่ได้ ----
  //
  // ต้องอยู่ก่อนทุกอย่างที่จำค่าไว้ (พีควัน พีคเดือน หน้าต่าง 15 นาที ค่าไฟ)
  // เพราะพวกนั้นเก็บค่าสูงสุดแบบถาวร ค่าขยะจุดเดียวจึงค้างอยู่ทั้งเดือน
  // ทิ้งทั้งจุดไปเลย ไม่ตัดยอดให้ดูดี — ค่าที่ผิดต้องไม่ถูกนับ ไม่ใช่ถูกย่อ
  const maxKw = cfg.maxPlausibleKw;
  const bad = [
    ['ไฟจากการไฟฟ้า', sample.grid],
    ['โซลาร์', sample.pv],
    ['โหลดรวม', sample.load],
  ].find(([, v]) => !Number.isFinite(v) || Math.abs(v) > maxKw);

  if (bad) {
    const why = `ค่าที่อ่านได้ผิดปกติจนเป็นไปไม่ได้: ${bad[0]} = ${bad[1]} kW (เพดานที่ยอมรับ ${maxKw} kW) — ข้ามจุดนี้ไป`;
    const state = { ...prev, lastError: { at: now, message: why } };
    await writeState(env, state);
    return { ok: false, error: why, rejected: sample };
  }

  // ---- 0) สถิติสูงสุดของเดือน แยกทีละสาย ----
  //
  // demand เก็บเฉพาะไฟหลวงแบบเฉลี่ย 15 นาที เพราะนั่นคือตัวที่การไฟฟ้าคิดเงิน
  // แต่เวลาดูย้อนหลังเพื่อหาสาเหตุ ต้องรู้ด้วยว่าเดือนนั้นโหลดขึ้นไปสูงสุดเท่าไหร่
  // และโซลาร์ช่วยได้สูงสุดเท่าไหร่ ค่าพวกนี้เก็บเป็นค่า ณ ขณะนั้น ไม่ใช่เฉลี่ย
  const mk = monthKey(now);
  const mp = prev.monthPeaks && prev.monthPeaks.key === mk
    ? { ...prev.monthPeaks }
    : { key: mk, gridKw: 0, gridAt: 0, loadKw: 0, loadAt: 0, pvKw: 0, pvAt: 0 };
  if (sample.grid > mp.gridKw) { mp.gridKw = sample.grid; mp.gridAt = now; }
  if (sample.load > mp.loadKw) { mp.loadKw = sample.load; mp.loadAt = now; }
  if (sample.pv > mp.pvKw) { mp.pvKw = sample.pv; mp.pvAt = now; }

  // ---- 1) คิดค่า demand ตามหน้าต่าง 15 นาทีของการไฟฟ้า ----
  const demandRes = feedDemand(prev.demand || emptyDemand(), now, sample.grid, cfg);
  const headroom = monthHeadroom(demandRes.demand, cfg, demandRes.window.projectedKw);

  // ---- 1.5) สะสมพลังงานไว้คิดค่าไฟจริงตามโครงสร้างบิล PEA ----
  const bill = feedBill(prev.bill, now, sample.grid, cfg);

  // ---- 2) สายที่หนึ่ง: เตือนคนเรื่องค่าไฟ (มีการหน่วงเวลากันเตือนหลอก) ----
  const { state, events, cause, demand15, actions } = evaluate(prev, sample, cfg, now);
  state.demand = demandRes.demand;
  state.monthPeaks = mp;
  state.lastSample = sample; // ค่าล่าสุดจริง ไม่ผ่านการบางประวัติ
  state.bill = bill;
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

  // ---- 5) บันทึกสถานะก่อน แล้วค่อยส่งข้อความ ----
  //
  // ลำดับนี้สำคัญมาก และเคยกลับด้านอยู่จนเกิดปัญหาจริงเมื่อ 3 ส.ค. 2569
  //
  // ตัวกันสแปมทั้งหมด (lastSentAt / lastSentLevel / lastNightAlertAt / streak)
  // อยู่ใน state ถ้าส่งข้อความก่อนแล้วเซฟไม่สำเร็จ ข้อความออกไปแล้วแต่ระบบจำไม่ได้
  // ว่าเคยส่ง รอบถัดไปจึงส่งใบเดิมซ้ำอีก แล้วซ้ำอีกทุกรอบไม่มีที่สิ้นสุด
  // วันนั้นโควตาเขียน KV หมด writeState เลยพังทุกครั้ง พนักงานได้ข้อความรัว ๆ
  //
  // เซฟไม่ได้ = ไม่ส่ง ยอมเงียบดีกว่าสแปมจนคนปิดการแจ้งเตือนทิ้งทั้งหมด
  let sent = [];
  try {
    await writeState(env, state);
  } catch (err) {
    return { ok: false, error: `บันทึกสถานะไม่สำเร็จ จึงไม่ส่งข้อความ (กันเตือนซ้ำไม่รู้จบ): ${err.message}`, sample };
  }

  for (const ev of allEvents) {
    const msg = buildMessage(ev, cfg, now);
    if (!msg) continue;
    // นอกเวลางาน ส่งหาหัวหน้าคนเดียว ไม่กวนกลุ่มพนักงาน (ดู isStaffHours)
    const offHours = !isStaffHours(cfg, now);
    const tg = await sendChat(cfg, msg.telegram, {
      toBoss: !!msg.toBoss || offHours,
      silent: msg.priority === 'low',
      bossOnly: offHours,
    });
    let mail = { skipped: 'ไม่ส่งอีเมลสำหรับเหตุการณ์นี้' };
    // อีเมลเก็บไว้เฉพาะเรื่องใหญ่ ไม่งั้นคนจะชินแล้วเลิกอ่าน
    if (msg.priority === 'high' && msg.emailSubject) mail = await sendEmail(cfg, msg.emailSubject, msg.emailHtml);
    sent.push({ type: ev.type, chat: tg.ok, email: !!mail.ok });
  }
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

/**
 * โหมด push: เช็คว่าตัวอ่านในโรงงานยังส่งข้อมูลอยู่ไหม
 * "เงียบ" ต้องไม่ถูกตีความว่า "ปกติ" — ถ้าตัวอ่านตายแล้วไม่มีใครรู้ จะเข้าใจผิดว่าปลอดภัยอยู่
 */
/**
 * ยามเฝ้าเซิร์ฟเวอร์ในโรงงาน
 *
 * ทำงานทุก 5 นาทีจาก cron ถ้าสัญญาณ "ยังอยู่ดี" ขาดเกิน localDownMin
 * แปลว่าเครื่องในโรงงานตายแล้ว ซึ่งเป็นความล้มเหลวที่อันตรายที่สุดของระบบนี้
 * เพราะทุกอย่างย้ายไปอยู่บนเครื่องนั้นหมดแล้ว ถ้าไม่มีใครบอก จะไปรู้ตอนบิลมา
 *
 * เตือนครั้งเดียวต่อการดับหนึ่งครั้ง ไม่ย้ำซ้ำ — คนรู้แล้วก็คือรู้แล้ว
 * และการย้ำทุก 5 นาทีจะทำให้คนปิดการแจ้งเตือนทิ้ง ซึ่งแย่กว่า
 */
async function checkLocalAlive(env, cfg) {
  const state = (await readState(env)) || emptyState();
  const hb = state.heartbeat;

  // ยังไม่เคยได้รับสัญญาณเลย = ยังไม่ได้เปิดใช้โหมดนี้ ไม่ใช่ความผิดปกติ
  if (!hb || !hb.at) return { ok: true, mode: 'ยังไม่ได้ใช้เซิร์ฟเวอร์ในโรงงาน' };

  const quietMin = minutesBetween(Date.now(), hb.at);
  if (quietMin < cfg.localDownMin) return { ok: true, quietMin: Math.round(quietMin) };
  if (state.localDownNotifiedAt) return { ok: false, quietMin, alerted: false };

  await writeState(env, { ...state, localDownNotifiedAt: Date.now() });
  await sendChat(
    cfg,
    `🖥️ <b>เซิร์ฟเวอร์ในโรงงานหยุดทำงาน</b>\n${escapeTg(cfg.siteName)} • ${hhmm()} น.\n` +
      `ไม่ได้รับสัญญาณมา ${Math.round(quietMin)} นาที (ค่าล่าสุดเมื่อ ${hhmm(hb.at)} น.)\n\n` +
      `ให้ไปเช็คว่าคอมเปิดอยู่ไหม / โปรแกรมยังรันอยู่หรือเปล่า\n\n` +
      `<i>ตอนนี้ไม่มีใครเฝ้าเพดาน ${cfg.demandLimitKw} kW ให้แล้ว ต้องเฝ้าเองไปก่อนครับ</i>`,
    { bossOnly: !isStaffHours(cfg), toBoss: true },
  );
  return { ok: false, quietMin, alerted: true };
}

async function checkPushHealth(env, cfg) {
  const now = Date.now();
  const state = await readState(env);
  const last = state.samples?.[state.samples.length - 1];
  const quietMin = last ? minutesBetween(now, last.t) : Infinity;

  if (quietMin < STALE_MINUTES) return { ok: true, quietMin: Math.round(quietMin) };
  if (minutesBetween(now, state.lastSilenceAlertAt || 0) < 180) return { ok: false, quietMin, alerted: false };

  await writeState(env, { ...state, lastSilenceAlertAt: now });
  await sendChat(
    cfg,
    `⚠️ <b>ตัวอ่านในโรงงานหยุดส่งข้อมูล</b>\n${escapeTg(cfg.siteName)} • ${hhmm(now)} น.\n` +
      (last ? `ข้อมูลล่าสุดเมื่อ ${hhmm(last.t)} น. (${Math.round(quietMin)} นาทีที่แล้ว)` : 'ยังไม่เคยได้รับข้อมูลเลย') +
      `\n\nให้ช่างเช็ค: อุปกรณ์ยังมีไฟไหม / ต่อ WiFi ได้ไหม / สาย RS485 หลุดหรือเปล่า` +
      `\n\n<i>ช่วงนี้ระบบเฝ้าเรื่องเพดาน ${cfg.demandLimitKw} kW ให้ไม่ได้ ต้องเฝ้าเองไปก่อน</i>`,
    { bossOnly: !isStaffHours(cfg, now), toBoss: true },
  );
  return { ok: false, quietMin, alerted: true };
}

/* ---------------------------------------------------------------- สรุปประจำวัน */

async function dailySummary(env, cfg) {
  const now = Date.now();
  const state = await readState(env);
  const msg = buildDailySummary(state, cfg, now, monthHeadroom(state.demand || emptyDemand(), cfg));
  if (!msg) return { ok: false, error: 'ยังไม่มีข้อมูลของวันนี้' };

  await sendChat(cfg, msg.telegram, { silent: true });
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

  /**
   * ตอบกลับห้องที่พิมพ์มาเสมอ — คนพิมพ์คำสั่งคือคนที่กำลังรอคำตอบอยู่หน้าจอ
   *
   * ไม่เกี่ยวกับกฎ "นอกเวลางานไม่กวนกลุ่ม" เพราะนั่นคือระบบเป็นฝ่ายทัก
   * ส่วนอันนี้คนเป็นฝ่ายถามเอง จะกี่โมงก็ต้องได้คำตอบกลับที่เดิม
   */
  const chatId = update?.message?.chat?.id;
  const isGroup = update?.message?.chat?.type?.includes('group');
  const reply = (body, opts) => replyTelegram(cfg, chatId, body, opts);

  /**
   * คำสั่งที่คนอื่นควรรู้ด้วย (/ack /done /restore)
   *
   * ตอบกลับห้องที่พิมพ์เสมอ และถ้าพิมพ์มาจากห้องส่วนตัวก็ประกาศเข้ากลุ่มด้วย
   * ไม่งั้นคนในกลุ่มจะไม่รู้ว่ามีคนรับเรื่องไปแล้ว แล้วก็จะไปทำซ้ำกัน
   * — เว้นนอกเวลางาน ที่ตอนนั้นไม่มีใครอยู่ให้ต้องบอกอยู่แล้ว
   */
  const announce = async (body) => {
    await reply(body, { silent: true });
    if (!isGroup && isStaffHours(cfg, now)) await sendChat(cfg, body, { silent: true });
  };

  if (cmd === '/ack' || cmd === '/รับทราบ') {
    await writeState(env, { ...state, ackAt: now, ackBy: name, ackAtKw: state.samples?.[state.samples.length - 1]?.grid || 0 });
    await announce(`👍 รับทราบแล้วโดย <b>${escapeTg(name)}</b> — ระบบจะหยุดเตือนซ้ำ ${cfg.ackSuppressMin} นาที\nถ้าไฟหลวงยังเข้าหนักหลังจากนั้น จะเตือนใหม่อีกครั้ง`);
    return json({ ok: true });
  }


  // แจ้งว่าทำงานประจำเรียบร้อยแล้ว (เผื่อระบบวัดโหลดไม่ทัน หรือปิดอย่างอื่นแทน)
  if (cmd === '/done' || cmd === '/ปิดแล้ว') {
    const schedule = { ...(state.schedule || emptyScheduleState()), tasks: { ...(state.schedule?.tasks || {}) } };
    const pending = Object.entries(schedule.tasks).filter(([, t]) => !t.done && !t.gaveUp);
    for (const [id, t] of pending) schedule.tasks[id] = { ...t, done: true, doneAt: now, doneBy: name };
    await writeState(env, { ...state, schedule });
    await announce(
      pending.length
        ? `✅ รับทราบว่า${pending.map(([id]) => escapeTg((cfg.dailyTasks || []).find((t) => t.id === id)?.name || id)).join(', ')} เรียบร้อยแล้ว (โดย ${escapeTg(name)})\n\n<i>ระบบจะหยุดย้ำ แต่ยังเฝ้าเรื่องเพดาน ${cfg.demandLimitKw} kW ให้ตามปกติ</i>`
        : `ตอนนี้ไม่มีงานที่ค้างอยู่ครับ`,
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
    await announce(
      offZones.length
        ? `✅ เปิดกลับ ${offZones.length} โซนแล้ว (โดย ${escapeTg(name)})\n${offZones.map((z) => `• ${escapeTg(z.name)}`).join('\n')}\n\n<i>ระบบจะไม่สั่งปิดอัตโนมัติอีก 30 นาที</i>`
        : `ตอนนี้ไม่มีโซนไหนถูกสั่งปิดอยู่ครับ`,
    );
    return json({ ok: true });
  }

  if (cmd === '/status' || cmd === '/สถานะ') {
    /**
     * โหมด local: สมองอยู่บนเครื่องในโรงงาน คลาวด์รู้เท่าที่สัญญาณ "ยังอยู่ดี" บอก
     *
     * ต้องอ่านจากตรงนั้น ไม่ใช่จาก samples ซึ่งเป็นของเก่าจากสมัยที่คลาวด์ยังดึง
     * FusionSolar เอง — ค้างอยู่ตั้งแต่วันที่ย้ายระบบและจะไม่ขยับอีกเลย
     * ต้องบอกอายุข้อมูลด้วยเสมอ ตัวเลขที่ไม่บอกว่าเก่าแค่ไหนคือตัวเลขที่หลอกคนอ่าน
     */
    const hb = state.heartbeat;
    if (cfg.dataSource === 'local' && hb?.at) {
      const ageMin = Math.round(minutesBetween(now, hb.at));
      const icon = { green: '🟢 ปกติ', yellow: '🟡 เฝ้าระวัง', red: '🔴 ต้องลดโหลด' }[hb.level] || '⚪ ไม่มีข้อมูล';
      const h = hb.headroom || {};
      const w = hb.window;
      const mp = hb.monthPeaks;
      const stale = ageMin > 20;
      const body = [
        icon,
        `ดึงไฟหลวง <b>${round1(hb.gridImportKw)} kW</b> | โซลาร์ ${round1(hb.pvKw)} kW | โหลด ${round1(hb.loadKw)} kW`,
        w ? `⏱ หน้าต่างนี้เหลือ ${w.remainMin} นาที คาดจบที่ <b>${round1(w.projectedKw)} kW</b>` : '',
        `📅 <b>สูงสุดของเดือน${h.monthKey ? ` ${escapeTg(h.monthKey)}` : ''}</b>`,
        h.peakKw != null ? `   ไฟหลวง <b>${round1(h.peakKw)} kW</b> (เฉลี่ย 15 นาที ตัวที่การไฟฟ้าคิดเงิน)` : '',
        h.peakAt ? `   ทำไว้เมื่อ ${thWhen(h.peakAt)} น.` : '',
        h.limitKw != null ? `   เพดานที่ตั้งไว้ ${h.limitKw} kW — เหลืออีก ${round1(h.headroomKw)} kW` : '',
        mp ? `   โหลดรวมสูงสุด ${round1(mp.loadKw)} kW — ${thWhen(mp.loadAt)} น.` : '',
        mp ? `   โซลาร์สูงสุด ${round1(mp.pvKw)} kW — ${thWhen(mp.pvAt)} น.` : '',
        hb.billMonth != null ? `💸 ค่าไฟเดือนนี้ ≈ <b>${Math.round(hb.billMonth).toLocaleString('th-TH')} บาท</b>`
          + (hb.billToday != null ? ` (วันนี้ ${Math.round(hb.billToday).toLocaleString('th-TH')} บาท)` : '') : '',
        '',
        stale
          ? `⚠️ <b>ข้อมูลเก่า ${ageMin} นาที</b> (${hhmm(hb.at)} น.) — คลาวด์ยังรับสัญญาณจากเครื่องในโรงงานไม่ได้\n`
            + '<i>ตัวเครื่องน่าจะยังเฝ้าไฟให้อยู่ ให้ดูตัวเลขสดที่หน้าจอในโรงงาน</i>'
          : `<i>ข้อมูลเมื่อ ${hhmm(hb.at)} น. (${ageMin} นาทีที่แล้ว) — คลาวด์รับรายงานทุก 10 นาที ตัวเลขสดอยู่ที่หน้าจอในโรงงาน</i>`,
      ].filter(Boolean).join('\n');
      await reply(body, { silent: true });
      return json({ ok: true });
    }

    const s = state.samples?.[state.samples.length - 1];
    const icon = { green: '🟢 ปกติ', yellow: '🟡 เฝ้าระวัง', red: '🔴 ต้องลดโหลด' }[state.level] || '⚪ ไม่มีข้อมูล';
    const w = state.window;
    const h = monthHeadroom(state.demand || emptyDemand(), cfg, w?.projectedKw || 0);
    const mp = state.monthPeaks && state.monthPeaks.key === h.monthKey ? state.monthPeaks : null;
    const offZones = (cfg.zones || []).filter((z) => state.shed?.zones?.[z.id]?.off);
    const body = s
      ? [
          icon,
          `ดึงไฟหลวง <b>${round1(s.grid)} kW</b> | โซลาร์ ${round1(s.pv)} kW | โหลด ${round1(s.load)} kW`,
          w ? `⏱ หน้าต่างนี้เหลือ ${w.remainMin} นาที คาดจบที่ <b>${round1(w.projectedKw)} kW</b>` : '',
          // เลี่ยงคำว่า "พีค" เพราะในบิล TOU คำว่า Peak แปลว่าช่วงเวลา 09:00-22:00
          // ไม่ได้แปลว่าสูงสุด เขียนเต็มไปเลยจะได้ไม่มีใครอ่านผิด
          `📅 <b>สูงสุดของเดือน ${escapeTg(h.monthKey || '')}</b>`,
          `   ไฟหลวง <b>${round1(h.livePeakKw)} kW</b> (เฉลี่ย 15 นาที ตัวที่การไฟฟ้าคิดเงิน)`,
          // วันเวลาผูกกับ peakKw ที่ล็อกแล้ว ไม่ใช่ livePeakKw — ถ้าหน้าต่างปัจจุบันกำลังทำสถิติใหม่
          // มันยังไม่จบ จะบอกว่า "เกิดเมื่อ" ไม่ได้
          h.peakAt ? `   ทำไว้เมื่อ ${thWhen(h.peakAt)} น. (${round1(h.peakKw)} kW)` : '',
          `   เพดานที่ตั้งไว้ ${h.limitKw} kW — เหลืออีก ${round1(h.headroomKw)} kW`,
          mp ? `   โหลดรวมสูงสุด ${round1(mp.loadKw)} kW — ${thWhen(mp.loadAt)} น.` : '',
          mp ? `   โซลาร์สูงสุด ${round1(mp.pvKw)} kW — ${thWhen(mp.pvAt)} น.` : '',
          mp ? `   ไฟหลวงสูงสุด ณ ขณะนั้น ${round1(mp.gridKw)} kW — ${thWhen(mp.gridAt)} น.` : '',
          offZones.length ? `⛔ ถูกสั่งปิดอยู่: ${offZones.map((z) => escapeTg(z.name)).join(', ')}` : '',
          `ข้อมูลเมื่อ ${hhmm(s.t)} น.`,
        ]
          .filter(Boolean)
          .join('\n')
      : `${icon}\nยังไม่มีข้อมูล`;
    await reply(body, { silent: true });
    return json({ ok: true });
  }

  /**
   * /id — บอกเลขห้องแชทนี้ ตอบกลับเข้าห้องเดิมโดยตรง ไม่ผ่าน sendChat
   *
   * มีไว้ตั้ง TELEGRAM_BOSS_CHAT_ID (ห้องส่วนตัวของหัวหน้า ใช้ส่งเรื่องนอกเวลางาน)
   * ซึ่งไม่มีทางรู้เลขนี้จากที่ไหนอีก Telegram ไม่มีหน้าจอให้ดู ต้องถามบอทเท่านั้น
   *
   * ต้องตอบกลับห้องที่พิมพ์มาเท่านั้น ถ้าใช้ sendChat มันจะไปโผล่ที่กลุ่มพนักงาน
   * ซึ่งเป็นคนละห้องกับที่ถาม แล้วก็จะได้เลขของกลุ่มแทน = ผิดทั้งคู่
   */
  if (cmd === '/id') {
    const kind = isGroup ? 'กลุ่ม' : 'ห้องส่วนตัว';
    const already = String(chatId) === String(cfg.telegramBossChatId);
    await reply(
      `🪪 ${kind}นี้คือ\n\n<code>${chatId}</code>\n\n`
        + (already
          ? '✅ <b>ห้องนี้ตั้งเป็นห้องของหัวหน้าไว้แล้ว</b>\n'
            + `<i>เรื่องที่เกิดหลัง ${cfg.staffHourEnd}:00 น. ถึง ${cfg.staffHourStart}:00 น. จะส่งมาที่นี่ห้องเดียว ไม่กวนกลุ่มพนักงาน</i>`
          : 'ถ้านี่คือห้องส่วนตัวของหัวหน้า ให้เอาเลขนี้ไปตั้งด้วยคำสั่ง\n'
            + '<code>npx wrangler secret put TELEGRAM_BOSS_CHAT_ID</code>'),
      { silent: true },
    );
    return json({ ok: true });
  }

  if (cmd === '/help' || cmd === '/start') {
    await reply(
      `🤖 <b>คำสั่งที่ใช้ได้</b>
/status — ดูสถานะตอนนี้ + สูงสุดของเดือน
/done — แจ้งว่าปิดแอร์ตามรอบแล้ว
/ack — รับเรื่องแล้ว กำลังไปจัดการ (หยุดย้ำซ้ำ ${cfg.ackSuppressMin} นาที แต่ถ้าไฟหลวงยังไต่ขึ้นจะเตือนใหม่ทันที)
/restore — เปิดอุปกรณ์ที่ระบบสั่งปิดกลับทั้งหมด
/id — บอกเลขห้องแชทนี้ (ใช้ตอนตั้งค่าห้องส่วนตัวของหัวหน้า)

<i>หลัง ${cfg.staffHourEnd}:00 น. ถึง ${cfg.staffHourStart}:00 น. ระบบจะไม่ส่งเข้ากลุ่มนี้ แต่ส่งหาหัวหน้าคนเดียว</i>

<i>ไม่มีคำสั่งปิดเสียง — ระบบนี้เงียบไม่ได้ เพราะพลาดครั้งเดียวผูกยาว 12 เดือน</i>`,
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
  return viewState(await readState(env), cfg);
}

/**
 * แปลง state ดิบเป็นตัวเลขที่หน้าจอและอุปกรณ์ภายนอกใช้
 *
 * แยกออกมาจาก publicState เพื่อให้เซิร์ฟเวอร์บนเครื่องในโรงงาน (server/) เรียกใช้
 * ตัวเดียวกันได้ — ตัวเลขบนหน้าจอในโรงงานกับบนคลาวด์จะได้ตรงกันเสมอ
 * ไม่ใช่คิดคนละสูตรแล้วมาเถียงกันทีหลังว่าฝั่งไหนถูก
 */
export function viewState(state, cfg) {
  // ใช้ค่าที่อ่านได้ล่าสุดจริง ไม่ใช่จุดล่าสุดในประวัติ
  //
  // ประวัติถูกบางออกเหลือช่วงละ sampleGapSec (ค่าเริ่มต้น 2 นาที) เพื่อให้เก็บ
  // ครบ 24 ชั่วโมงโดยไฟล์ไม่บวม แต่ตัวเลขบนหน้าจอต้องเป็นของ "เดี๋ยวนี้"
  // เซิร์ฟเวอร์ในโรงงานอ่านทุก 5 วินาที ถ้าอ่านจากประวัติจะดูเหมือนค้างไป 2 นาที
  // ทั้งที่ข้อมูลสดอยู่ — และ stale ก็จะเพี้ยนตามไปด้วย
  const newest = state.lastSample || null;
  const fromHistory = state.samples?.[state.samples.length - 1] || null;
  const last = newest && (!fromHistory || newest.t >= fromHistory.t) ? newest : fromHistory;
  const stale = !last || minutesBetween(Date.now(), last.t) > STALE_MINUTES;
  const coveragePct = last && last.load > 0 ? Math.round(((last.load - Math.max(0, last.grid)) / last.load) * 100) : null;
  const demand = state.demand || emptyDemand();
  // คิดหน้าต่างใหม่ ณ เวลาที่เรียก เพื่อให้ตัวเลข "เหลืออีกกี่นาที" ตรงกับความจริง
  const win = last && !stale ? windowView(demand, Date.now(), last.grid, cfg) : state.window || null;
  const headroom = monthHeadroom(demand, cfg, win && !stale ? win.projectedKw : 0);
  // เกณฑ์ที่ใช้จริง ณ ตอนที่เรียก ไม่ใช่ตอนที่เก็บ state ไว้ — หน้าจอต้องโชว์ของปัจจุบัน
  const th = activeThresholds(cfg, Date.now());

  // ฉุกเฉินจริง = ไฟหลวงหนักอยู่ตอนนี้ หรือ หน้าต่าง 15 นาทีนี้กำลังจะจบเกินเส้นที่ต้องลงมือ
  // สองเงื่อนไขนี้แยกกันโดยสิ้นเชิง อันแรกดูค่าปัจจุบัน อันหลังดูแนวโน้มของทั้งหน้าต่าง
  const emergency = !stale && (state.level === 'red' || (!!win && win.projectedKw >= cfg.demandActionKw));

  return {
    level: stale ? 'unknown' : state.level,
    stale,
    // ---- สัญญาณฉุกเฉิน: ไฟหมุน + ไซเรนบนหน้าจอ อ่านตัวนี้ตัวเดียว ----
    //
    // เดิมผูกไว้กับ state.level อย่างเดียว ซึ่งคิดจาก "ไฟหลวง ณ ขณะนี้" เท่านั้น
    // 3 ส.ค. 2569 พบว่าหน้าต่าง 15 นาทีจะจบที่ 47 kW บนเพดาน 20 kW (เหลือระยะ -27)
    // แต่ค่า ณ ขณะนั้นอยู่แค่ 0.2 kW จึงเป็นสีเขียว ไซเรนเลยไม่ดังสักแอะ
    // ทั้งที่เป็นสถานการณ์ที่ระบบทั้งระบบสร้างมาเพื่อกัน
    //
    // จึงต้องดังเมื่อ "จะเกิน" ด้วย ไม่ใช่เฉพาะตอน "เกินอยู่ตอนนี้"
    emergency,
    emergencyReason: emergency
      ? state.level === 'red'
        ? 'ไฟหลวงกำลังเข้าหนักตอนนี้'
        : `หน้าต่าง 15 นาทีนี้จะจบที่ ${r(win.projectedKw)} kW`
      : null,
    siren: emergency, // ให้ ESP32 อ่านค่านี้ไปสั่งไฟหมุน
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

    // สูงสุดของเดือนแยกทีละสาย เป็นค่า ณ ขณะนั้น (ไม่ใช่เฉลี่ย 15 นาที) พร้อมเวลาที่เกิด
    // เช็ค key ก่อนเสมอ ไม่งั้นวันที่ 1 ของเดือนใหม่จะเอาสถิติเดือนก่อนมาโชว์
    monthPeaks:
      state.monthPeaks && state.monthPeaks.key === headroom.monthKey
        ? {
            gridKw: r(state.monthPeaks.gridKw),
            gridAt: state.monthPeaks.gridAt || 0,
            loadKw: r(state.monthPeaks.loadKw),
            loadAt: state.monthPeaks.loadAt || 0,
            pvKw: r(state.monthPeaks.pvKw),
            pvAt: state.monthPeaks.pvAt || 0,
          }
        : null,

    // ค่าไฟจริงตามโครงสร้างบิล PEA — เดือนนี้คิดครบทุกรายการ วันนี้คิดเฉพาะค่าพลังงาน
    // ส่งพีคที่ตัวติดตาม demand รู้เข้าไปด้วย เผื่อตัวคิดเงินเพิ่งเริ่มนับกลางเดือน
    // แล้วมองไม่เห็นพีคที่เกิดก่อนหน้า (ดูเหตุผลเต็มใน billView)
    bill: state.bill
      ? {
          month: billView(state.bill, cfg, 'month', headroom.peakKw || 0, headroom.peakAt || 0),
          day: billView(state.bill, cfg, 'day'),
        }
      : null,

    todayPeakKw: r(demand.todayPeakKw || 0),
    autoshed: {
      mode: cfg.autoshedMode,
      offZones: (cfg.zones || []).filter((z) => state.shed?.zones?.[z.id]?.off).map((z) => ({ id: z.id, name: z.name, kw: z.kw })),
    },
    targets: { warnKw: th.warnKw, critKw: th.critKw, actionKw: cfg.demandActionKw, targetKw: cfg.demandTargetKw },
    // ตอนนี้อยู่ในช่วงเฝ้าระวังเข้มหรือยัง (15:00 จนจบ on-peak) — หน้าจอเอาไปขึ้นแถบเตือน
    eveningWatch: th.evening
      ? { active: true, fromHour: cfg.eveningWatchHour, baseWarnKw: cfg.warnKw, baseCritKw: cfg.critKw }
      : { active: false, fromHour: cfg.eveningWatchHour },
    cause: state.cause || null,
    actions: state.level === 'green' ? [] : state.actions || [],
    ackBy: state.ackBy || null,
    mutedUntil: state.mutedUntil || 0,
    warnKw: th.warnKw,
    critKw: th.critKw,
    updatedAt: last ? last.t : null,
    lastError: state.lastError?.message || null,
  };
}

const r = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** ทุกโซนเปิด — ใช้เป็นค่า fail-safe เวลาระบบไม่มีข้อมูลสด */
function allOn(cfg) {
  const out = {};
  for (const z of cfg.zones || []) out[z.id] = { name: z.name, kw: z.kw, power: 'on', since: 0, protected: !!z.protected };
  return out;
}

function escapeTg(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * ตรวจว่า request มาจาก LINE จริง
 *
 * LINE เซ็น body ด้วย HMAC-SHA256 โดยใช้ channel secret แล้วส่งมาใน
 * header x-line-signature เป็น base64 ถ้าไม่ตรวจ ใครก็ยิงอะไรเข้ามาก็ได้
 */
async function verifyLineSignature(secret, body, signature) {
  if (!signature) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return expected === signature;
  } catch {
    return false;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
