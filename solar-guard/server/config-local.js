/**
 * ตั้งค่าสำหรับเซิร์ฟเวอร์บนเครื่องในโรงงาน
 *
 * อ่านค่าจาก wrangler.toml ส่วน [vars] โดยตรง เพื่อให้มี "แหล่งความจริงเดียว"
 * กับที่รันบน Cloudflare — เกณฑ์เตือน เพดาน อัตราค่าไฟ ต้องตรงกันเสมอ
 * ไม่ใช่แก้ที่หนึ่งแล้วลืมอีกที่ แล้วสองฝั่งเตือนไม่เหมือนกันโดยไม่มีใครรู้
 *
 * ลำดับความสำคัญ (มากไปน้อย):
 *   1. ตัวแปรสภาพแวดล้อมของโปรเซส   (ใช้ทดสอบ/แก้ชั่วคราว)
 *   2. ไฟล์ .dev.vars ข้าง ๆ wrangler.toml (ความลับ เช่นโทเคน — ห้าม commit)
 *   3. [vars] ใน wrangler.toml       (ค่าจริงที่ใช้งาน)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

/** อ่านเฉพาะส่วน [vars] ของ wrangler.toml — ไม่ต้องใช้ไลบรารี TOML เต็มรูปแบบ */
function readWranglerVars(file) {
  if (!existsSync(file)) return {};
  const out = {};
  let inVars = false;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#') || !line) continue;
    if (line.startsWith('[')) { inVars = line === '[vars]'; continue; }
    if (!inVars) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!m) continue;
    let v = m[2].trim();
    // ตัดคอมเมนต์ท้ายบรรทัดเฉพาะที่อยู่นอกเครื่องหมายคำพูด
    if (v.startsWith('"')) {
      const end = v.indexOf('"', 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.split('#')[0].trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/** ไฟล์ .dev.vars รูปแบบ KEY=value บรรทัดละตัว */
function readDevVars(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function loadLocalConfig(overrides = {}) {
  const env = {
    ...readWranglerVars(join(ROOT, 'wrangler.toml')),
    ...readDevVars(join(ROOT, '.dev.vars')),
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    ...overrides,
  };
  const cfg = loadConfig(env);

  // รหัสผ่านสำหรับคนกรอกในหน้า login — ตั้งเองให้จำง่ายและพิมพ์บนมือถือได้
  //
  // แยกจาก DASHBOARD_TOKEN โดยตั้งใจ: โทเคน 32 ตัวยังคงใช้กับ header x-token
  // สำหรับสคริปต์และอุปกรณ์ ส่วนคนใช้รหัสนี้ ไม่ต้องพกสตริงยาว ๆ ไปไหนมาไหน
  // ถ้าไม่ตั้ง จะยอมรับโทเคนแทนไปก่อน (ระบบไม่ล็อกตัวเองออก)
  cfg.dashboardPassword = env.DASHBOARD_PASSWORD || '';

  // ค่าเฉพาะของฝั่งเซิร์ฟเวอร์ในโรงงาน ไม่มีบน Cloudflare
  cfg.local = {
    port: num(env.LOCAL_PORT, 8787),
    dbFile: env.LOCAL_DB || join(ROOT, 'data', 'solar-guard.db'),
    inverterHost: env.INVERTER_HOST || '192.168.1.26',
    inverterPort: num(env.INVERTER_PORT, 502),
    inverterUnit: num(env.INVERTER_UNIT, 1),
    // -1 เพราะไซต์นี้รายงานการซื้อไฟเป็นค่าลบ ดูเหตุผลใน server/modbus.js
    modbusMeterSign: num(env.MODBUS_METER_SIGN, -1),
    readEverySec: num(env.LOCAL_READ_SEC, 5),
    // ส่งสัญญาณ "ยังอยู่ดี" ขึ้นคลาวด์ทุกกี่วินาที
    // 10 นาที = 144 ครั้ง/วัน จากโควตา 1,000 ของ KV แพ็กฟรี
    heartbeatSec: num(env.HEARTBEAT_SEC, 600),
    workerUrl: env.WORKER_URL || '',
    ingestToken: env.INGEST_TOKEN || '',

    // เติมรูข้อมูลจากพอร์ทัลอัตโนมัติตอนเริ่มทำงาน
    // เครื่องนี้ปิดตัวเองทุกคืนตี 3 จึงมีรูวันละ 4-5 ชั่วโมงเป็นปกติ
    gapfill: (env.GAPFILL || 'true') !== 'false',
    gapfillMinGapMin: num(env.GAPFILL_MIN_GAP_MIN, 20),
    gapfillTimeoutSec: num(env.GAPFILL_TIMEOUT_SEC, 240),
    readerDir: env.READER_DIR || join(ROOT, 'local-reader'),
  };
  return cfg;
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
