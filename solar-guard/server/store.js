/**
 * ที่เก็บข้อมูลบนเครื่อง — มาแทน Cloudflare KV
 *
 * ใช้ node:sqlite ที่ติดมากับ Node 22+ อยู่แล้ว ไม่ต้องลง npm เพิ่มสักตัว
 *
 * เหตุผลที่ย้ายมา: KV แพ็กฟรีเขียนได้ 1,000 ครั้ง/วัน ซึ่งแปลว่าอัปเดตได้อย่างเร็ว
 * ทุก ~90 วินาที ส่วนไฟล์บนเครื่องนี้เขียนทุก 5 วินาที = 17,280 ครั้ง/วัน
 * ยังไม่ทำให้ดิสก์รู้สึกอะไรเลย
 *
 * เก็บสองอย่างแยกกันโดยตั้งใจ:
 *   state    ก้อน JSON ก้อนเดียว รูปร่างเหมือนที่เคยเก็บใน KV เป๊ะ ๆ
 *            ทำแบบนี้เพื่อให้ src/ ทั้งหมดใช้ต่อได้โดยไม่ต้องแก้อะไรเลย
 *   readings ทุกจุดที่อ่านได้ ความละเอียดเต็ม ไม่ต้องตัดทิ้งเพื่อประหยัดที่
 *            (KV ต้องยัดประวัติลงไปในก้อน state ด้วย เลยเก็บได้จำกัด)
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);

    // WAL: ให้อ่านได้ระหว่างที่กำลังเขียน หน้าจอจะได้ไม่ค้างตอนบันทึก
    this.db.exec('PRAGMA journal_mode = WAL');
    // NORMAL แทน FULL: เขียนทุก 5 วินาทีตลอดวัน ไม่ต้อง fsync ทุกครั้ง
    // อย่างแย่ที่สุดคือไฟดับแล้วเสียข้อมูลไม่กี่วินาทีสุดท้าย ซึ่งรับได้
    this.db.exec('PRAGMA synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS readings (
        t    INTEGER PRIMARY KEY,   -- epoch ms
        pv   REAL NOT NULL,
        grid REAL NOT NULL,
        load REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS readings_t ON readings(t);
    `);

    this._get = this.db.prepare('SELECT v FROM kv WHERE k = ?');
    this._put = this.db.prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    this._add = this.db.prepare('INSERT INTO readings (t,pv,grid,load) VALUES (?,?,?,?) ON CONFLICT(t) DO NOTHING');
    this._range = this.db.prepare('SELECT t,pv,grid,load FROM readings WHERE t >= ? ORDER BY t');
    this._prune = this.db.prepare('DELETE FROM readings WHERE t < ?');
  }

  readState() {
    const row = this._get.get('state');
    if (!row) return null;
    try { return JSON.parse(row.v); } catch { return null; }
  }

  writeState(state) {
    this._put.run('state', JSON.stringify(state));
  }

  addReading(t, pv, grid, load) {
    this._add.run(Math.round(t), pv, grid, load);
  }

  /**
   * ประวัติสำหรับวาดกราฟ
   *
   * บีบให้เหลือตามจำนวนที่ขอ โดยเลือก "จุดที่ไฟหลวงสูงสุด" ของแต่ละช่วง
   * ไม่ใช่จุดล่าสุด — ระบบนี้มีไว้จับพีค ถ้าเก็บจุดล่าสุดแล้วพีคไปเกิดกลางช่วง
   * กราฟจะไม่เห็นเลย (เคยพลาดตรงนี้มาแล้วตอนเก็บประวัติลง KV)
   */
  history(sinceMs, maxPoints = 720) {
    const rows = this._range.all(Math.round(sinceMs));
    if (rows.length <= maxPoints) return rows;

    const span = rows[rows.length - 1].t - rows[0].t;
    const bucket = Math.max(1, Math.ceil(span / maxPoints));
    const out = [];
    let cur = null;
    for (const r of rows) {
      const b = Math.floor(r.t / bucket);
      if (!cur || cur.b !== b) {
        cur = { b, row: r };
        out.push(cur);
      } else if (r.grid > cur.row.grid) {
        cur.row = r;
      }
    }
    return out.map((x) => x.row);
  }

  /** ทุกจุดในช่วงที่ระบุ ไม่บีบ — ใช้ตอนสร้างสถิติของเดือนใหม่ */
  all(fromMs, toMs = Infinity) {
    return this._range.all(Math.round(fromMs)).filter((r) => r.t <= toMs);
  }

  /**
   * หาช่วงที่ข้อมูลขาด
   *
   * เครื่องนี้ปิดตัวเองทุกคืนตี 3 (task AutoShutdown_0300) แล้วเปิดใหม่ตอนเช้า
   * จึงมีรูในข้อมูลทุกวัน ตัวนี้บอกว่ารูอยู่ตรงไหนบ้าง จะได้ไปดึงจากพอร์ทัลมาเติม
   */
  gaps(fromMs, minGapMin = 20) {
    const rows = this._range.all(Math.round(fromMs));
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const mins = (rows[i].t - rows[i - 1].t) / 60000;
      if (mins >= minGapMin) out.push({ from: rows[i - 1].t, to: rows[i].t, minutes: Math.round(mins) });
    }
    return out;
  }

  /** ลบประวัติที่เก่ากว่ากี่วัน — กันไฟล์โตไม่มีที่สิ้นสุด */
  prune(days = 400) {
    this._prune.run(Date.now() - days * 86400000);
  }

  stats() {
    const n = this.db.prepare('SELECT count(*) c, min(t) a, max(t) b FROM readings').get();
    return { rows: n.c, first: n.a, last: n.b };
  }

  close() {
    try { this.db.close(); } catch { /* ปิดไม่ได้ก็ไม่เป็นไร กำลังจะออกอยู่แล้ว */ }
  }
}
