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
import { round1, round3, thDateKey, hhmm, isStaffHours } from '../src/util.js';
import { loadLocalConfig } from './config-local.js';
import { Store } from './store.js';
import { Inverter } from './modbus.js';
import { makeRelay } from './notify-relay.js';
import { fillGaps, thaiMidnight } from './gapfill.js';
import { rebuildFromStore, applyRebuild } from './rebuild.js';
import { Zones, buildShedList } from './zones.js';
import { zonesHtml } from '../src/zones-page.js';

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
let heartbeatFails = 0;

const zones = new Zones(store, (m) => log(m));

/**
 * เอาค่าที่วัดได้จริงรายโซน ไปแทนรายการ "ให้ไปปิดอะไร" ที่ใช้ตอนเตือน
 *
 * รายการตั้งต้นในโค้ดเป็นตัวอย่างสมมติ (ปั๊มน้ำสำรอง คอมเพรสเซอร์ตัวที่ 2)
 * ซึ่งไม่มีอยู่จริงที่นี่ พอวัดโซนจริงแล้วต้องให้ข้อความที่ส่งออกทุกช่องทาง
 * พูดถึงของที่มีอยู่จริง พร้อมตัวเลขที่วัดมาเอง
 *
 * เรียกทุกครั้งที่วัดเสร็จ ไม่ต้องรีสตาร์ทเซิร์ฟเวอร์
 */
function applyShedList() {
  const list = buildShedList(zones);
  if (!list.length) return 0;
  cfg.loadShed = list;
  return list.length;
}

/**
 * ตั้งเกณฑ์ "กลางคืนแต่ยังใช้ไฟอยู่" จากของที่วัดจริง
 *
 * ค่าคงที่ในไฟล์ตั้งค่าไม่มีทางถูก เพราะมันไม่รู้ว่าไฟส่องสว่างที่ปิดไม่ได้กินเท่าไร
 * ตั้ง 3 kW ทั้งที่ไฟส่องสว่างอย่างเดียวก็ 3.4 kW = เตือนทุกคืนทั้งที่ไม่มีอะไรผิด
 * แล้วคนก็เลิกอ่าน ซึ่งอันตรายกว่าไม่เตือนเลย
 */
function applyNightIdle() {
  const n = zones.nightIdleKw();
  if (!n) return null;
  cfg.nightIdleKw = n.kw;
  return n;
}

const log = (msg, level = 'INFO') => {
  const line = `[${new Date().toLocaleString('sv-SE')}] ${level} ${msg}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
};

const rawRelay = makeRelay(cfg, log);

/**
 * ส่งข้อความ โดยเคารพเวลาพักของพนักงาน
 *
 * นอกเวลางาน (ค่าเริ่มต้นหลัง 19:00 ถึง 08:00) ข้อความจะไปหาหัวหน้าคนเดียว
 * ไม่เข้ากลุ่ม — ไม่ได้เงียบ เพราะช่วง on-peak ยาวถึง 22:00 พีคที่เกิดตอน
 * สองทุ่มก็แพงเท่าพีคตอนบ่าย แต่คนที่ควรถูกปลุกคือคนที่สั่งปิดอะไรได้
 */
async function relay(text, opts = {}) {
  const staffTime = isStaffHours(cfg);
  return rawRelay(text, { ...opts, bossOnly: !staffTime, toBoss: opts.toBoss || !staffTime });
}

/* ------------------------------------------------------------------ วงจรหลัก */

/**
 * ประมวลผลค่าที่อ่านได้หนึ่งจุด — ทำงานเหมือน poll() บนคลาวด์ทุกประการ
 * ต่างกันแค่ที่เก็บข้อมูลและวิธีส่งข้อความ
 */
async function processReading(reading, now = Date.now()) {
  const prev = store.readState() || emptyState();

  const sample = {
    t: now,
    // เก็บ 3 ตำแหน่ง — อินเวอร์เตอร์ส่งมาเป็นวัตต์อยู่แล้ว การปัดเหลือ 1 ตำแหน่ง
    // คือการโยนข้อมูลจริงทิ้ง แล้วพอไปวัดโหลดทีละตัว (0.3 kW) ก็หยาบเกินใช้งาน
    pv: round3(reading.pv),
    grid: round3(reading.grid),
    load: round3(reading.load),
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
      // ส่งข้อมูลให้ครบพอที่คลาวด์จะตอบ /status ได้ด้วยตัวเอง
      //
      // เดิมส่งแค่ 4 ตัวเลขพอให้รู้ว่า "ยังไม่ตาย" ผลคือใครพิมพ์ /status ใส่บอท
      // จะได้ตัวเลขจากครั้งสุดท้ายที่คลาวด์ดึงจาก FusionSolar เองซึ่งอาจเก่าเป็น
      // ชั่วโมง โดยไม่มีอะไรบอกว่ามันเก่า (เจอจริง 3 ส.ค. 69 — /status บอก 17:32
      // ตอนห้าทุ่มครึ่ง)
      body: JSON.stringify({
        at: Date.now(),
        level: view.level,
        gridImportKw: view.gridImportKw,
        pvKw: view.pvKw,
        loadKw: view.loadKw,
        monthPeakKw: view.month?.peakKw ?? null,
        emergency: view.emergency,
        window: view.window || null,
        headroom: view.month || null,
        monthPeaks: view.monthPeaks || null,
        billToday: view.bill?.day?.totalBaht ?? null,
        billMonth: view.bill?.month?.totalBaht ?? null,
        nightIdleKw: cfg.nightIdleKw,
      }),
    });
    const out = await res.json().catch(() => ({}));

    // ส่งถึงแล้วแต่คลาวด์เซฟไม่ได้ (โควตาเขียนรายวันหมด)
    // ไม่ใช่ความผิดของเรา แต่ต้องรู้ เพราะ /status ในแชทจะค้างที่ค่าเก่า
    if (res.ok && out.saved === false && out.saveError) {
      heartbeatFails++;
      log(`คลาวด์รับแล้วแต่บันทึกไม่ได้: ${out.saveError}`, 'WARN');
      if (heartbeatFails === 3 && !NO_ALERTS) {
        await relay(
          `⚠️ <b>คลาวด์บันทึกสถานะไม่ได้</b>\n${cfg.siteName} • ${hhmm()} น.\n`
          + `เหตุผล: ${out.saveError}\n\n`
          + 'เครื่องในโรงงาน<b>ยังเฝ้าไฟให้ครบทุกอย่าง</b> และยังส่งข้อความเตือนได้ตามปกติ\n'
          + 'ที่ใช้ไม่ได้ชั่วคราวคือ /status ในแชท (จะให้ตัวเลขเก่า) — ดูตัวเลขสดที่หน้าจอในโรงงานแทน\n\n'
          + '<i>ถ้าเป็นโควตารายวันของ Cloudflare จะหายเองตอน 07:00 น.</i>',
          { toBoss: true, silent: true },
        );
      }
      return;
    }

    if (!res.ok) {
      const detail = out;
      heartbeatFails++;
      log(`ส่งสัญญาณยังอยู่ดีไม่สำเร็จ: HTTP ${res.status} ${detail.error || ''}`, 'WARN');

      // โควตาเขียนของคลาวด์หมด = คลาวด์จะไม่รู้ว่าเรายังอยู่ แล้วอาจเตือนว่า
      // เครื่องตายทั้งที่ยังทำงานปกติ และ /status จะค้างอยู่ที่ค่าเก่า
      // ต้องบอกคน เพราะอาการนี้เงียบสนิทถ้าไม่มีใครเปิดล็อกอ่าน
      // (ช่องส่งข้อความไม่แตะ KV จึงยังส่งได้แม้โควตาเขียนหมด)
      if (heartbeatFails === 3 && !NO_ALERTS) {
        await relay(
          `⚠️ <b>คลาวด์รับสัญญาณไม่ได้</b>\n${cfg.siteName} • ${hhmm()} น.\n`
          + `เหตุผล: ${detail.error || `HTTP ${res.status}`}\n\n`
          + 'เครื่องในโรงงาน<b>ยังเฝ้าไฟให้ตามปกติทุกอย่าง</b> และยังส่งข้อความได้\n'
          + 'ที่ใช้ไม่ได้ชั่วคราวคือ /status ในแชท (จะให้ตัวเลขเก่า) — ให้ดูที่หน้าจอในโรงงานแทน\n\n'
          + '<i>ถ้าเป็นเรื่องโควตารายวันของ Cloudflare จะหายเองตอน 07:00 น.</i>',
          { toBoss: true, silent: true },
        );
      }
      return;
    }
    if (heartbeatFails >= 3) log(`ส่งสัญญาณยังอยู่ดีได้แล้ว (พลาดไป ${heartbeatFails} ครั้ง)`);
    heartbeatFails = 0;
  } catch (err) {
    heartbeatFails++;
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
    // ส่งข้อมูลทั้งวันจากฐานข้อมูลเข้าไปคิด ไม่ใช่ประวัติย่อที่ติดมากับ state
    //
    // state.samples เก็บไว้ไม่กี่ชั่วโมงเพราะมันถูกออกแบบมาให้ยัดลง KV ได้
    // ส่วน kWh ของทั้งวันต้องใช้ข้อมูลทั้งวันจริง ๆ ไม่งั้นได้เลขที่ต่ำกว่าความจริง
    // หลายเท่า แล้วบรรทัด "ซื้อไฟ" (ซึ่งมาจากตัวคิดค่าไฟที่เก็บครบ) จะมากกว่า
    // บรรทัด "ใช้ไฟรวม" ซึ่งเป็นไปไม่ได้ทางฟิสิกส์ — เจอจริง 3 ส.ค. 69
    const daySamples = store.all(thaiMidnight()).map((r) => ({ t: r.t, pv: r.pv, grid: r.grid, load: r.load }));
    const msg = buildDailySummary(
      { ...out.state, samples: daySamples.length ? daySamples : out.state.samples },
      cfg,
      Date.now(),
      monthHeadroom(out.state.demand || emptyDemand(), cfg),
    );
    if (msg) await relay(msg.telegram, { silent: true, emailSubject: msg.emailSubject, emailHtml: msg.emailHtml });
  }
}

/* ----------------------------------------------------------------- หน้าเว็บ */

/**
 * หน้าเข้าสู่ระบบ — เหมือนแอพอื่นในบริษัท
 *
 * ตั้งใจให้กรอกบนมือถือได้จริง: ช่องเดียว ปุ่มเดียว ตัวใหญ่ กดง่าย
 * ไม่มี JavaScript เลย ฟอร์ม HTML ล้วน จะได้ไม่พังเวลาเน็ตโรงงานช้า
 */
function loginPage(error = '') {
  const e = error
    ? `<p style="background:#7f1d1d55;border:1px solid #ef444488;color:#fca5a5;padding:12px 16px;border-radius:10px;margin-bottom:18px">${escapeHtml(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>เข้าสู่ระบบ — เฝ้าระวังการใช้ไฟ</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b1120;color:#e2e8f0;
       min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .box{background:#111c33;border:1px solid #1e293b;border-radius:18px;padding:32px;width:100%;max-width:420px}
  h1{font-size:22px;margin-bottom:6px}
  .sub{color:#94a3b8;font-size:15px;margin-bottom:24px}
  label{display:block;font-size:14px;color:#94a3b8;margin-bottom:8px}
  input{width:100%;padding:16px;font-size:19px;border-radius:12px;border:1px solid #334155;
        background:#0b1120;color:#f8fafc;font-family:inherit}
  input:focus{outline:none;border-color:#f59e0b}
  button{width:100%;margin-top:16px;padding:16px;font-size:18px;font-weight:700;border:none;
         border-radius:12px;background:#f59e0b;color:#0b1120;cursor:pointer;font-family:inherit}
  .hint{color:#64748b;font-size:13px;margin-top:20px;line-height:1.6}
</style></head><body>
  <form class="box" method="POST" action="/login">
    <h1>⚡ เฝ้าระวังการใช้ไฟ</h1>
    <div class="sub">${escapeHtml(cfg.siteName)}</div>
    ${e}
    <label for="p">รหัสผ่าน</label>
    <input id="p" name="password" type="password" autofocus autocomplete="current-password" inputmode="text">
    <button type="submit">เข้าสู่ระบบ</button>
    <div class="hint">เข้าครั้งเดียว เครื่องนี้จะจำไว้ 1 ปี<br>ถ้าลืมรหัส ดูได้ที่ไฟล์ .dev.vars บนเครื่องเซิร์ฟเวอร์</div>
  </form>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** อ่าน body ที่เป็น JSON — จำกัดขนาดไว้ ไม่ให้ใครยัดอะไรใหญ่ ๆ เข้ามา */
async function readJson(req, limit = 8192) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) break;
  }
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  // ---- ด่านเข้าใช้งาน ----
  //
  // มีหน้า login เหมือนแอพอื่นในบริษัท ไม่ใช่โทเคน 32 ตัวต่อท้าย URL
  //
  // ของเดิมออกแบบตอนที่คิดว่าจะมีแต่จอติดผนังเปิดค้าง เลยใช้รหัสใน URL ซึ่งง่ายสุด
  // แต่พอมีคนเปิดจากมือถือจริง มันกลายเป็นภาระ: พิมพ์ไม่ไหว จำไม่ได้ และจบลงด้วย
  // การส่งลิงก์เต็ม ๆ ที่มีรหัสต่อกันในแชท ซึ่งอันตรายกว่ากรอกรหัสในฟอร์มเสียอีก
  //
  // สามทางที่ยอมรับ:
  //   คุกกี้         คนที่ล็อกอินแล้ว (อยู่ได้ 1 ปี)
  //   x-token header อุปกรณ์/สคริปต์ที่เรียก API
  //   ?k=            ลิงก์เดิมที่เคยใช้ ยังทำงานได้ ไม่ต้องแก้บุ๊กมาร์ก
  const secret = cfg.dashboardToken;
  if (secret) {
    const cookies = String(req.headers.cookie || '');
    const fromCookie = /(?:^|;\s*)sg_auth=([^;]+)/.exec(cookies)?.[1];
    const passOk = fromCookie && decodeURIComponent(fromCookie) === secret;
    const headerOk = req.headers['x-token'] === secret;
    const queryOk = url.searchParams.get('k') === secret;

    const setCookieAndGo = (to) => {
      res.writeHead(302, {
        'Set-Cookie': `sg_auth=${encodeURIComponent(secret)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`,
        Location: to,
        'Cache-Control': 'no-store',
      });
      res.end();
    };

    // ส่งฟอร์มมา
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) break; }
      const typed = decodeURIComponent((/(?:^|&)password=([^&]*)/.exec(body)?.[1] || '').replace(/\+/g, ' '));
      if (typed && (typed === cfg.dashboardPassword || typed === secret)) return setCookieAndGo('/');
      return send(200, loginPage('รหัสผ่านไม่ถูกต้อง'), 'text/html; charset=utf-8');
    }

    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'sg_auth=; Max-Age=0; Path=/', Location: '/login' });
      return res.end();
    }

    if (!passOk && !headerOk && !queryOk) {
      // API ตอบ 401 เปล่า ๆ ส่วนคนตอบเป็นหน้าฟอร์ม
      if (url.pathname.startsWith('/api/')) return send(401, { ok: false, error: 'ต้องเข้าสู่ระบบก่อน' });
      return send(200, loginPage(), 'text/html; charset=utf-8');
    }

    // เข้าด้วย ?k= -> ฝากคุกกี้แล้วล้างรหัสออกจาก URL
    // ไม่ให้ติดไปกับบุ๊กมาร์ก ประวัติเบราว์เซอร์ หรือภาพหน้าจอที่ส่งต่อกัน
    if (queryOk && !passOk) {
      const clean = url.pathname + (url.search.replace(/(^\?|&)k=[^&]*/, '').replace(/^&/, '?') || '');
      return setCookieAndGo(clean || '/');
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
      // ค่าเริ่มต้น = ตั้งแต่เที่ยงคืนของวันไทย ไม่ใช่ย้อนหลัง 24 ชั่วโมงแบบเลื่อนไปเรื่อย ๆ
      //
      // แบบเลื่อนทำให้แกนเวลาขยับตลอด ดูวันนี้เทียบวันก่อนไม่ได้ และช่วงเช้ามืด
      // ของเมื่อวานจะปนเข้ามาในกราฟของวันนี้ ซึ่งอ่านแล้วสับสน
      // ระบุ ?day=YYYY-MM-DD เพื่อดูวันย้อนหลัง หรือ ?hours=N เพื่อดูแบบเลื่อน
      const dayParam = url.searchParams.get('day');
      const hours = Number(url.searchParams.get('hours'));

      let from;
      let to = null;
      if (Number.isFinite(hours) && hours > 0) {
        from = Date.now() - hours * 3600000;
      } else {
        // เฉพาะช่วงที่กราฟแสดงจริง (ค่าเริ่มต้น 05:30-21:00) ไม่ต้องส่งกลางดึกมา
        // ให้เปลืองแบนด์วิดท์และเวลาวาด ในเมื่อกราฟตัดทิ้งอยู่แล้ว
        const mid = thaiMidnight(dayParam);
        from = mid + cfg.chartStartHour * 3600000;
        to = mid + cfg.chartEndHour * 3600000;
      }

      // ต้องห่อด้วย { samples: [...] } ให้ตรงกับที่ฝั่งคลาวด์ส่ง
      // หน้าจอใช้ไฟล์เดียวกันทั้งสองฝั่ง และมันอ่าน hist.samples
      const rows = store.history(from).filter((r) => !to || r.t < to);
      return send(200, { samples: rows, dayStart: to ? from : null });
    }
    // ปิดตัวเองเพื่อให้ watchdog เปิดใหม่ = วิธีรีสตาร์ทที่ไม่ต้องใช้สิทธิ์ผู้ดูแล
    //
    // watchdog ของร้านรันด้วย S4U โปรเซสนี้จึงอยู่ใน session 0 คนละที่กับหน้าจอ
    // ที่คนล็อกอินอยู่ ใครที่ไม่ได้เป็นผู้ดูแลจึงสั่งหยุดมันไม่ได้เลย
    // ซึ่งแปลว่าการแก้โค้ดทุกครั้งต้องไปรบกวนคนให้มากดอนุญาต
    //
    // ทางออกคือให้มันฆ่าตัวเอง แล้ว watchdog เก็บกวาดให้ภายใน 1 นาที
    // ต้องมีโทเคนถึงจะสั่งได้ และเป็น POST เท่านั้น กันคนกดลิงก์เล่น
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      log('ได้รับคำสั่งรีสตาร์ท — ปิดตัวเอง แล้วให้ watchdog เปิดใหม่ (ไม่เกิน 1 นาที)', 'WARN');
      send(200, { ok: true, note: 'watchdog จะเปิดใหม่ภายใน 1 นาที' });
      setTimeout(() => {
        try { inv.disconnect(); store.close(); } catch { /* กำลังจะออกอยู่แล้ว */ }
        process.exit(0);
      }, 300);
      return;
    }

    // ---- วัดโหลดรายโซน ----
    //
    // มีไว้ตอบคำถามเดียว: ไฟเกินแล้วให้ไปปิดอะไรก่อน ถึงจะลงพอโดยกวนคนน้อยสุด
    // ตอบไม่ได้ถ้าไม่รู้ว่าแต่ละตัวกินเท่าไร จึงต้องเปิดทีละตัวแล้ววัดจริง
    if (url.pathname === '/loads') {
      return send(200, zonesHtml(cfg), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/loads') {
      return send(200, { ok: true, ...zones.overview(cfg) });
    }
    if (url.pathname === '/api/loads/start' && req.method === 'POST') {
      const body = await readJson(req);
      const t = zones.start(String(body.zone || ''), { preRunning: !!body.preRunning, byOff: !!body.byOff });
      return send(200, { ok: true, test: t });
    }
    if (url.pathname === '/api/loads/confirm' && req.method === 'POST') {
      const body = await readJson(req);
      const result = zones.confirm(body.id);
      const n = applyShedList();
      applyNightIdle();
      return send(200, { ok: true, result, shedCount: n });
    }
    if (url.pathname === '/api/loads/stop' && req.method === 'POST') {
      const body = await readJson(req);
      const result = zones.stop(String(body.note || ''));
      const n = applyShedList();
      applyNightIdle();
      log(`รายการให้ไปปิดตอนไฟเกิน อัปเดตแล้ว ${n} รายการ (จากค่าที่วัดจริง)`);
      return send(200, { ok: true, result, shedCount: n });
    }
    // บันทึกย้อนหลัง: {zone, fromMinAgo, toMinAgo} — เผื่อเปิดเครื่องไปแล้วค่อยนึกได้
    if (url.pathname === '/api/loads/record' && req.method === 'POST') {
      const b = await readJson(req);
      const now = Date.now();
      const from = now - Number(b.fromMinAgo || 0) * 60000;
      const to = now - Number(b.toMinAgo || 0) * 60000;
      const result = zones.record(String(b.zone || ''), from, to, String(b.note || ''), !!b.preRunning,
        b.baseKw === undefined || b.baseKw === null || b.baseKw === '' ? null : Number(b.baseKw), !!b.byOff);
      const n = applyShedList();
      applyNightIdle();
      return send(200, { ok: true, result, shedCount: n });
    }
    if (url.pathname === '/api/loads/cancel' && req.method === 'POST') {
      return send(200, { ok: true, cancelled: zones.cancel() });
    }
    // ---- จัดการรายการโซน (เพิ่ม/แก้/เอาออก/เลื่อนลำดับ) ----
    // โรงงานซื้อของเพิ่มได้ตลอด รายการจึงต้องแก้ได้จากหน้าจอ ไม่ใช่ต้องมาแก้โค้ด
    if (url.pathname === '/api/loads/zone' && req.method === 'POST') {
      const zone = zones.saveZone(await readJson(req));
      applyShedList();
      applyNightIdle();
      return send(200, { ok: true, zone });
    }
    if (url.pathname === '/api/loads/zone/remove' && req.method === 'POST') {
      const b = await readJson(req);
      zones.removeZone(String(b.slug || ''));
      applyShedList();
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/loads/zone/restore' && req.method === 'POST') {
      const b = await readJson(req);
      const zone = zones.restoreZone(String(b.slug || ''));
      applyShedList();
      return send(200, { ok: true, zone });
    }
    if (url.pathname === '/api/loads/zone/move' && req.method === 'POST') {
      const b = await readJson(req);
      zones.moveShedOrder(String(b.slug || ''), b.dir === 'up' ? 'up' : 'down');
      applyShedList();
      return send(200, { ok: true });
    }

    if (url.pathname === '/api/loads/history') {
      const z = url.searchParams.get('zone');
      return send(200, { ok: true, tests: z ? zones.history(z) : [] });
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

// ถ้าเคยวัดโหลดรายโซนไว้ ให้ใช้ค่าจริงตั้งแต่วินาทีแรก ไม่ต้องรอวัดใหม่
{
  const n = applyShedList();
  log(n
    ? `รายการให้ไปปิดตอนไฟเกิน: ใช้ค่าที่วัดจริง ${n} โซน (แก้ได้ที่หน้า /loads)`
    : 'ยังไม่เคยวัดโหลดรายโซน — เวลาเตือนจะยังใช้รายการตัวอย่างที่เดาไว้ (ไปวัดที่หน้า /loads)');

  const ni = applyNightIdle();
  log(ni
    ? `เกณฑ์กลางคืน: ${ni.kw} kW (ไฟส่องสว่าง ${ni.baselineKw} + ของที่เปิดกลางคืนได้ ${ni.nightAllowedKw} + เผื่อ ${ni.marginKw})`
    : `เกณฑ์กลางคืน: ${cfg.nightIdleKw} kW (ค่าจากไฟล์ตั้งค่า — ยังวัดไฟส่องสว่างไม่ครบ)`);
}

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

// เติมรูข้อมูลของวันนี้ก่อนเริ่มเดินเครื่อง
//
// ต้องทำทุกครั้งที่เปิด ไม่ใช่ครั้งเดียว เพราะเครื่องปิดตัวเองทุกคืนตี 3
// ถ้าไม่เติม กราฟจะขาดวันละ 4-5 ชั่วโมง และค่าไฟจะต่ำกว่าจริงทุกวัน
//
// ทำเป็นเบื้องหลัง ไม่ให้บล็อกการอ่าน Modbus — การดึงจากพอร์ทัลใช้เวลาเป็นนาที
// และถ้าพอร์ทัลล่ม ระบบต้องยังเฝ้าไฟให้ได้ตามปกติ
if (!ONCE && cfg.local.gapfill) {
  (async () => {
    try {
      const added = await fillGaps(store, cfg, log, {
        sinceMs: thaiMidnight(),
        minGapMin: cfg.local.gapfillMinGapMin,
      });
      if (added > 0) {
        const built = rebuildFromStore(store, cfg);
        if (built) {
          applyRebuild(store, built);
          log(`คิดสถิติของเดือนใหม่จาก ${built.rows} จุด: ` +
              `พีค ${built.headroom.peakKw.toFixed(1)} kW | ` +
              `ค่าไฟ ${built.billMonth.totalBaht.toLocaleString('th-TH')} บาท`);
        }
      }
    } catch (err) {
      log(`เติมรูข้อมูลไม่สำเร็จ: ${err.message}`, 'WARN');
    }
  })();
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
