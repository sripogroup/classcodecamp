/**
 * Solar Guard — เซิร์ฟเวอร์ที่รันบนเครื่องในโรงงาน
 *
 * ทำไมถึงย้ายมา: Cloudflare KV แพ็กฟรีเขียนได้ 1,000 ครั้ง/วัน ซึ่งจำกัดให้
 * อัปเดตได้อย่างเร็วทุก ~90 วินาที และยังมีดีเลย์อีก 6-60 วินาทีจากการกระจาย
 * ข้อมูลระหว่างจุดให้บริการ ตัวนี้อ่านทุก 5 วินาทีและเห็นผลทันที
 *
 * แบ่งหน้าที่กับคลาวด์:
 *   เครื่องนี้    อ่าน Modbus / คิด demand+ค่าไฟ / หน้าจอในโรงงาน / ส่งแจ้งเตือน
 *   Cloudflare   รับสัญญาณ "ยังอยู่ดี" ทุก 10 นาที ถ้าขาดหายก็เตือนแทน
 *
 * เหตุผลที่ยังต้องมีคลาวด์: ถ้าเครื่องนี้ดับ ไฟดับ หรือ Windows รีสตาร์ทเอง
 * จะต้องมีใครสักคนที่ยัง "อยู่ข้างนอก" คอยบอก ไม่งั้นระบบตายเงียบ
 * แล้วจะไปรู้อีกทีตอนบิลมา
 *
 * สมองทั้งหมด (คิด demand / ค่าไฟ / ข้อความ / หน้าจอ) ใช้ไฟล์เดียวกับที่รัน
 * บนคลาวด์ ไม่ได้ลอกมาเขียนใหม่ ตัวเลขสองฝั่งจึงตรงกันเสมอ
 */

import http from 'node:http';
import { evaluate, evaluateDemand, emptyState } from '../src/analyze.js';
import { emptyBill, feedBill } from '../src/bill.js';
import { emptyDemand, feedDemand, monthHeadroom, monthKey } from '../src/demand.js';
import { checkSchedule, emptyScheduleState } from '../src/schedule.js';
import { buildDailySummary, buildMessage } from '../src/messages.js';


import { dashboardHtml } from '../src/dashboard.js';
import { viewState } from '../src/index.js';
import { round1, thDateKey, hhmm } from '../src/util.js';
import { loadLocalConfig } from './config-local.js';
import { Store } from './store.js';
import { Inverter } from './modbus.js';
import { makeRelay } from './notify-relay.js';

const args = new Set(process.argv.slice(2));
const NO_ALERTS = args.has('--no-alerts');
const ONCE = args.has('--once');

const cfg = loadLocalConfig();
const L = cfg.local;
const store = new Store(L.dbFile);
const inv = new Inverter({
  host: L.inverterHost,
  port: L.inverterPort,
  unit: L.inverterUnit,
  meterSign: L.modbusMeterSign,
});

let lastHeartbeat = 0;
let lastSummaryDay = '';
let consecutiveFails = 0;

const log = (msg, level = 'INFO') => {
  const line = `[${new Date().toLocaleString('sv-SE')}] ${level} ${msg}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
};

const relay = makeRelay(cfg, log);

/* ------------------------------------------------------------------ วงจรหลัก */

/**
 * ประมวลผลค่าที่อ่านได้หนึ่งจุด — ทำงานเหมือน poll() บนคลาวด์ทุกประการ
 * ต่างกันแค่ที่เก็บข้อมูลและวิธีส่งข้อความ
 */
async function processReading(reading, now = Date.now()) {
  const prev = store.readState() || emptyState();

  const sample = {
    t: now,
    pv: round1(reading.pv),
    grid: round1(reading.grid),
    load: round1(reading.load),
    bat: 0,
  };

  // ด่านกันค่าที่เป็นไปไม่ได้ — ต้องมาก่อนทุกอย่างที่จำค่าสูงสุดเอาไว้
  // เพราะพีควัน พีคเดือน และหน้าต่าง 15 นาที ลบเองไม่ได้ ค่าขยะจุดเดียวค้างทั้งเดือน
  const worst = Math.max(Math.abs(sample.pv), Math.abs(sample.grid), Math.abs(sample.load));
  if (!Number.isFinite(worst) || worst > cfg.maxPlausibleKw) {
    log(`ค่าที่อ่านได้เป็นไปไม่ได้ ข้ามไป: PV ${sample.pv} / Grid ${sample.grid} / Load ${sample.load} kW`, 'WARN');
    return null;
  }

  // ---- สถิติสูงสุดของเดือน แยกทีละสาย ----
  const mk = monthKey(now);
  const mp = prev.monthPeaks && prev.monthPeaks.key === mk
    ? { ...prev.monthPeaks }
    : { key: mk, gridKw: 0, gridAt: 0, loadKw: 0, loadAt: 0, pvKw: 0, pvAt: 0 };
  if (sample.grid > mp.gridKw) { mp.gridKw = sample.grid; mp.gridAt = now; }
  if (sample.load > mp.loadKw) { mp.loadKw = sample.load; mp.loadAt = now; }
  if (sample.pv > mp.pvKw) { mp.pvKw = sample.pv; mp.pvAt = now; }

  const demandRes = feedDemand(prev.demand || emptyDemand(), now, sample.grid, cfg);
  const headroom = monthHeadroom(demandRes.demand, cfg, demandRes.window.projectedKw);
  const bill = feedBill(prev.bill, now, sample.grid, cfg);

  const { state, events, cause, actions } = evaluate(prev, sample, cfg, now);
  state.demand = demandRes.demand;
  state.monthPeaks = mp;
  state.lastSample = sample; // ค่าล่าสุดจริง ไม่ผ่านการบางประวัติ
  state.bill = bill;
  state.window = demandRes.window;
  state.headroom = headroom;

  const allEvents = [...events];

  // สายที่สอง: กันไม่ให้หน้าต่าง 15 นาทีชนเพดาน (ไม่มีการหน่วงเวลา)
  const demandEval = evaluateDemand(
    state,
    { window: demandRes.window, headroom, closed: demandRes.closed, sample },
    cfg,
    now,
  );
  Object.assign(state, demandEval.state);
  allEvents.push(...demandEval.events);

  // งานประจำที่ต้องทำทุกวัน
  const sched = checkSchedule(state.schedule || emptyScheduleState(), state.samples, cfg, now);
  state.schedule = sched.state;
  allEvents.push(...sched.events);

  // บันทึกก่อน แล้วค่อยส่งข้อความ — ลำดับนี้สำคัญ
  // ถ้าส่งก่อนแล้วเซฟพลาด ระบบจะจำไม่ได้ว่าเคยส่ง แล้วส่งซ้ำทุกรอบไม่รู้จบ
  // (เกิดขึ้นจริงบนคลาวด์เมื่อ 3 ส.ค. 2569 ตอนโควตาเขียนหมด)
  store.writeState(state);
  store.addReading(now, sample.pv, sample.grid, sample.load);

  for (const ev of allEvents) {
    const msg = buildMessage(ev, cfg, now);
    if (!msg) continue;
    if (NO_ALERTS) { log(`[ไม่ส่งจริง] ${ev.type}: ${msg.telegram.split('\n')[0]}`); continue; }
    await relay(msg.telegram, {
      toBoss: !!msg.toBoss,
      silent: msg.priority === 'low',
      // อีเมลเก็บไว้เฉพาะเรื่องใหญ่ ไม่งั้นคนจะชินแล้วเลิกอ่าน
      emailSubject: msg.priority === 'high' ? msg.emailSubject : null,
      emailHtml: msg.priority === 'high' ? msg.emailHtml : null,
    });
  }

  return { state, sample, events: allEvents.map((e) => e.type) };
}

/**
 * บอกคลาวด์ว่า "ยังอยู่ดี"
 *
 * นี่คือทั้งหมดที่คลาวด์ยังต้องทำแล้ว: ถ้าสัญญาณนี้ขาดหาย แปลว่าเครื่องนี้ตาย
 * และต้องมีใครเตือน 10 นาทีครั้ง = 144 ครั้ง/วัน จากโควตา 1,000
 */
async function heartbeat(view) {
  if (!L.workerUrl || !L.ingestToken) return;
  try {
    const res = await fetch(`${L.workerUrl.replace(/\/$/, '')}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': L.ingestToken },
      body: JSON.stringify({
        at: Date.now(),
        level: view.level,
        gridImportKw: view.gridImportKw,
        pvKw: view.pvKw,
        loadKw: view.loadKw,
        monthPeakKw: view.month?.peakKw ?? null,
        emergency: view.emergency,
      }),
    });
    if (!res.ok) log(`ส่งสัญญาณยังอยู่ดีไม่สำเร็จ: HTTP ${res.status}`, 'WARN');
  } catch (err) {
    log(`ส่งสัญญาณยังอยู่ดีไม่สำเร็จ: ${err.message}`, 'WARN');
  }
}

async function tick() {
  let reading;
  try {
    if (!inv.connected) await inv.connect();
    reading = await inv.readNow();
    consecutiveFails = 0;
  } catch (err) {
    consecutiveFails++;
    log(`อ่านอินเวอร์เตอร์ไม่ได้ (${consecutiveFails}): ${err.message}`, 'WARN');
    inv.disconnect();
    return;
  }

  const out = await processReading(reading);
  if (!out) return;

  const view = viewState(out.state, cfg);
  if (Date.now() - lastHeartbeat >= L.heartbeatSec * 1000) {
    lastHeartbeat = Date.now();
    await heartbeat(view);
  }

  // สรุปประจำวัน 17:30 น. — เช็คจากวันไทย ไม่ใช่ตัวจับเวลา จะได้ไม่พลาดถ้าเครื่องหลับ
  const today = thDateKey();
  const hh = Number(hhmm().slice(0, 2));
  if (!NO_ALERTS && hh >= 17 && today !== lastSummaryDay) {
    lastSummaryDay = today;
    const msg = buildDailySummary(out.state, cfg, Date.now(), monthHeadroom(out.state.demand || emptyDemand(), cfg));
    if (msg) await relay(msg.telegram, { silent: true, emailSubject: msg.emailSubject, emailHtml: msg.emailHtml });
  }
}

/* ----------------------------------------------------------------- หน้าเว็บ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  // ---- ด่านโทเคน ----
  //
  // ใส่ ?k=... ครั้งเดียวแล้วจำไว้เป็นคุกกี้ 1 ปี
  //
  // จอติดผนังกับมือถือของพนักงานเปิดหน้านี้ทุกวัน การต้องพก URL ยาว ๆ ที่มีโทเคน
  // ต่อท้ายทุกครั้งจบลงด้วยการที่มีคนส่งลิงก์เต็ม ๆ ต่อกันในแชท ซึ่งแย่กว่าคุกกี้
  // httpOnly ที่ JavaScript อ่านไม่ได้และไม่โผล่ในแถบที่อยู่
  if (cfg.dashboardToken) {
    const cookies = String(req.headers.cookie || '');
    const fromCookie = /(?:^|;\s*)sg_token=([^;]+)/.exec(cookies)?.[1];
    const given = url.searchParams.get('k') || req.headers['x-token'] || (fromCookie && decodeURIComponent(fromCookie)) || '';

    if (given !== cfg.dashboardToken) {
      return send(401, 'ไม่มีสิทธิ์เข้าถึง — ต่อท้าย URL ด้วย ?k=รหัสของคุณ หนึ่งครั้ง', 'text/plain; charset=utf-8');
    }

    // เพิ่งผ่านด้วย ?k= -> ฝากคุกกี้ไว้ แล้วพาไปหน้าเดิมแบบไม่มีโทเคนใน URL
    // จะได้ไม่ติดไปกับบุ๊กมาร์ก ประวัติเบราว์เซอร์ หรือภาพหน้าจอที่ส่งต่อกัน
    if (url.searchParams.get('k') === cfg.dashboardToken) {
      const clean = url.pathname + (url.search.replace(/(^\?|&)k=[^&]*/, '').replace(/^&/, '?') || '');
      res.writeHead(302, {
        'Set-Cookie': `sg_token=${encodeURIComponent(cfg.dashboardToken)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`,
        Location: clean || '/',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
  }

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(200, dashboardHtml(cfg, cfg.dashboardToken), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/state') {
      return send(200, viewState(store.readState() || emptyState(), cfg));
    }
    if (url.pathname === '/api/history') {
      const hours = Number(url.searchParams.get('hours')) || 24;
      return send(200, store.history(Date.now() - hours * 3600000));
    }
    if (url.pathname === '/api/health') {
      return send(200, { ok: true, inverter: inv.connected, fails: consecutiveFails, db: store.stats() });
    }
    return send(404, { ok: false, error: 'ไม่พบหน้านี้' });
  } catch (err) {
    return send(500, { ok: false, error: err.message });
  }
});

/* -------------------------------------------------------------------- เริ่ม */

log(`Solar Guard เซิร์ฟเวอร์ในโรงงาน${NO_ALERTS ? ' [โหมดเทียบตัวเลข: ไม่ส่งแจ้งเตือนจริง]' : ''}`);
log(`อินเวอร์เตอร์ ${L.inverterHost}:${L.inverterPort} unit ${L.inverterUnit} (meterSign ${L.modbusMeterSign})`);
log(`ฐานข้อมูล ${L.dbFile}`);

// เปิดหน้าเว็บก่อนแตะอินเวอร์เตอร์
//
// เดิมรอต่อ Modbus ให้เสร็จก่อนถึงจะเปิดพอร์ต ซึ่งกลับหัวกลับหาง: เวลาที่
// อินเวอร์เตอร์ต่อไม่ได้คือเวลาที่อยากเปิดหน้าจอดูมากที่สุด แต่กลับเป็นเวลาที่
// หน้าจอไม่ขึ้นพอดี และทำให้แยกไม่ออกว่า "เซิร์ฟเวอร์ตาย" กับ "อ่านอินเวอร์เตอร์ไม่ได้"
if (!ONCE) {
  server.listen(L.port, () =>
    log(`หน้าจอเปิดที่ http://localhost:${L.port}/  (และ http://<ไอพีเครื่องนี้>:${L.port}/ จากในวง LAN)`));
}

try {
  await inv.connect();
  const id = await inv.identify();
  log(`ต่อติดแล้ว: ${id.model} SN ${id.serial} พิกัด ${(id.ratedW / 1000).toFixed(0)} kW ` +
      `มิเตอร์${id.meterOnline ? 'ออนไลน์' : 'ไม่ตอบ - ต้องตรวจ'}`);
} catch (err) {
  log(`ต่ออินเวอร์เตอร์ไม่ได้ตอนเริ่ม: ${err.message} — จะลองใหม่เรื่อย ๆ`, 'WARN');
}

if (ONCE) {
  await tick();
  const v = viewState(store.readState() || emptyState(), cfg);
  console.log(JSON.stringify(v, null, 2));
  store.close();
  process.exit(0);
}

await tick();
setInterval(() => { tick().catch((e) => log(e.message, 'ERROR')); }, L.readEverySec * 1000);
setInterval(() => store.prune(), 6 * 3600000);

// บันทึกไว้ให้รู้ว่าใครสั่งปิดและตอนไหน
//
// 3 ส.ค. 2569 เซิร์ฟเวอร์ถูกฆ่าซ้ำ ๆ ด้วย Ctrl+C โดยไม่มีร่องรอยว่าใครสั่ง
// เพราะหน้าต่างคอนโซลที่ Task Scheduler สร้างขึ้นในเซสชันที่ล็อกอินอยู่
// ส่งสัญญาณนี้มาให้เมื่อหน้าต่างแม่ถูกปิด กว่าจะรู้ว่าตายก็ผ่านไปหลายนาที
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      log(`ได้รับสัญญาณ ${sig} — กำลังปิด`, 'WARN');
      inv.disconnect();
      store.close();
      process.exit(0);
    });
  } catch { /* บางสัญญาณไม่มีบน Windows */ }
}
process.on('uncaughtException', (e) => log(`ข้อผิดพลาดที่ไม่ได้ดัก: ${e.stack || e.message}`, 'ERROR'));
process.on('unhandledRejection', (e) => log(`promise ที่ไม่ได้ดัก: ${e?.stack || e}`, 'ERROR'));
