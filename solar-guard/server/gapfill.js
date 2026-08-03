/**
 * เติมรูข้อมูลจากพอร์ทัล FusionSolar อัตโนมัติ
 *
 * ทำไมต้องมี: เครื่องนี้ปิดตัวเองทุกคืนตี 3 (scheduled task AutoShutdown_0300
 * สั่ง shutdown /s /f /t 0) แล้วเปิดใหม่ตอนเช้า ระหว่างนั้นไม่มีใครอ่าน Modbus
 * จึงเกิดรูในข้อมูลทุกวัน วันละ 4-5 ชั่วโมง
 *
 * รูนี้ทำให้:
 *   - กราฟขาดช่วงทุกวัน
 *   - ค่าไฟต่ำกว่าจริง เพราะช่วงตี 3 ถึงเช้าไม่ถูกนับ
 *   - พีคของเดือนอาจพลาด ถ้าบังเอิญพีคไปเกิดตอนนั้น
 *
 * พอร์ทัลของ Huawei เก็บข้อมูลย้อนหลังทุก 5 นาทีอยู่แล้ว จึงดึงมาเติมได้
 * ความละเอียด 5 นาทีหยาบกว่า Modbus (5 วินาที) แต่ตรงกับที่การไฟฟ้าใช้คิดพอดี
 * และดีกว่าไม่มีข้อมูลเลยมาก
 *
 * เรียกสคริปต์ PowerShell ตัวเดิมที่พิสูจน์กับพอร์ทัลจริงมาแล้ว แทนที่จะเขียน
 * ตัว login ใหม่ใน Node — พอร์ทัลนี้ใช้ auth stack UIDM ที่จับทางยาก และรหัส
 * เก็บอยู่ในไฟล์ DPAPI ที่อ่านได้เฉพาะจาก Windows เท่านั้น
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** "2026-08-03" ตามวันไทยของ epoch ms */
function thaiDay(ms) {
  return new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
}

/** เที่ยงคืนของวันไทย -> epoch ms */
export function thaiMidnight(dayStr = null, nowMs = Date.now()) {
  const d = dayStr || thaiDay(nowMs);
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd) - 7 * 3600000;
}

function runPowerShell(scriptPath, args, timeoutMs, log) {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', scriptPath, ...args],
      { windowsHide: true },
    );
    let out = '';
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* ตายไปแล้ว */ } }, timeoutMs);
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { out += d; });
    ps.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    ps.on('error', (err) => { clearTimeout(timer); log(`เรียก PowerShell ไม่สำเร็จ: ${err.message}`, 'WARN'); resolve({ code: -1, out }); });
  });
}

/** CSV -> [{t,pv,grid,load}] เวลาในไฟล์เป็นเวลาไทย */
function readCsv(file, maxKw) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const m = p[0].trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (!m) continue;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +m[6]);
    const pv = Number(p[1]); const grid = Number(p[2]); const load = Number(p[3]);
    if (![pv, grid, load].every(Number.isFinite)) continue;
    if (Math.max(Math.abs(pv), Math.abs(grid), Math.abs(load)) > maxKw) continue;
    rows.push({ t, pv, grid, load });
  }
  return rows;
}

/**
 * หารูแล้วเติม คืนจำนวนจุดที่เติมได้
 *
 * ดึงทีละวัน เพราะพอร์ทัลให้ข้อมูลเป็นรายวันอยู่แล้ว และการขอย้อนหลังหลายวัน
 * พร้อมกันเสี่ยงโดนจำกัดความถี่
 */
export async function fillGaps(store, cfg, log, { sinceMs = null, minGapMin = 20 } = {}) {
  const root = cfg.local.readerDir;
  const script = join(root, 'FusionWebReader.ps1');
  if (!existsSync(script)) { log(`ไม่พบ ${script} — ข้ามการเติมรู`, 'WARN'); return 0; }

  const from = sinceMs ?? thaiMidnight();
  const gaps = store.gaps(from, minGapMin);

  // ไม่มีข้อมูลเลยตั้งแต่ต้นช่วง ก็ถือว่าเป็นรูหนึ่งรู
  const first = store.all(from)[0];
  if (!first && Date.now() - from > minGapMin * 60000) {
    gaps.unshift({ from, to: Date.now(), minutes: Math.round((Date.now() - from) / 60000) });
  } else if (first && first.t - from >= minGapMin * 60000) {
    gaps.unshift({ from, to: first.t, minutes: Math.round((first.t - from) / 60000) });
  }

  if (!gaps.length) { log('ไม่มีรูข้อมูลที่ต้องเติม'); return 0; }

  for (const g of gaps) {
    log(`พบรูข้อมูล ${new Date(g.from + 7 * 3600000).toISOString().slice(11, 16)} - ` +
        `${new Date(g.to + 7 * 3600000).toISOString().slice(11, 16)} (${g.minutes} นาที)`);
  }

  const days = [...new Set(gaps.flatMap((g) => [thaiDay(g.from), thaiDay(g.to)]))].sort();
  const csv = join(tmpdir(), `solar-gapfill-${Date.now()}.csv`);
  let added = 0;

  try {
    log(`ดึงข้อมูลย้อนหลังจากพอร์ทัล ${days[0]} ถึง ${days[days.length - 1]}`);
    const res = await runPowerShell(
      script,
      ['-From', days[0], '-To', days[days.length - 1], '-CsvOut', csv],
      cfg.local.gapfillTimeoutSec * 1000,
      log,
    );
    if (res.code !== 0) log(`ตัวดึงข้อมูลจบด้วยรหัส ${res.code} — จะใช้เท่าที่เขียนออกมาได้`, 'WARN');

    const rows = readCsv(csv, cfg.maxPlausibleKw);
    if (!rows.length) { log('พอร์ทัลไม่ได้ให้ข้อมูลอะไรกลับมา', 'WARN'); return 0; }

    // ใส่เฉพาะจุดที่อยู่ในรูจริง ๆ ไม่ไปทับช่วงที่ Modbus อ่านมาแล้ว
    // ซึ่งละเอียดกว่ามาก (5 วินาที เทียบกับ 5 นาที)
    for (const r of rows) {
      if (!gaps.some((g) => r.t > g.from && r.t < g.to)) continue;
      store.addReading(r.t, r.pv, r.grid, r.load);
      added++;
    }
    log(`เติมข้อมูลเข้าไป ${added} จุด (จากที่ดึงมาทั้งหมด ${rows.length} จุด)`);
  } catch (err) {
    log(`เติมรูไม่สำเร็จ: ${err.message}`, 'WARN');
  } finally {
    try { unlinkSync(csv); } catch { /* ลบไม่ได้ก็ปล่อย เป็นไฟล์ชั่วคราว */ }
  }

  return added;
}
