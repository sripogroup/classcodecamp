/**
 * วัดว่าเครื่องใช้ไฟฟ้าแต่ละโซนกินไฟจริงกี่ kW
 *
 * ทำไมต้องมี: แอพเตือนได้อยู่แล้วว่าไฟเกิน แต่ตอนบอกว่า "ให้ไปปิดอะไร" มันใช้
 * รายการที่เดาตัวเลขเอาไว้ตอนเขียนโค้ด ซึ่งไม่ตรงกับของจริงในโรงงานสักตัว
 * คนอ่านข้อความแล้วไปปิดตาม พอปิดครบกลับพบว่าไฟยังไม่ลงพอ หรือปิดเกินจำเป็น
 *
 * วิธีวัด: เปิดทีละโซนโดยมีไฟส่องสว่างเป็นฐาน แล้วดูว่าโหลดเพิ่มขึ้นเท่าไร
 * ต้องเปิดค้างให้นานพอ เพราะแอร์ตอนเพิ่งเปิดกินไฟสูงกว่าตอนเดินปกติมาก
 * (ช่วงดึงอุณหภูมิลง) ถ้าวัดแค่ 3 นาทีจะได้แต่ค่าพีค ซึ่งสูงเกินจริงไปเยอะ
 *
 * เก็บอะไร: เก็บแค่ "ช่วงเวลาที่เปิด" ลงฐานข้อมูล ตัวเลขคำนวณสดจากตาราง
 * readings (5 วินาที/จุด) ทุกครั้งที่เรียกดู แปลว่าถ้าวันหลังพบว่าสูตรคิดผิด
 * ก็แก้สูตรแล้วค่าเก่าถูกต้องตามไปเองทั้งหมด ไม่ต้องไปวัดใหม่
 * (มี snapshot เก็บไว้ด้วย เผื่อ readings ถูก prune ทิ้งหลัง 400 วัน)
 */

import { round1, round2 } from '../src/util.js';

/* ------------------------------------------------------------ รายการโซน */

/**
 * โซนทั้งหมดในโรงงาน — พ่อเต้ยเป็นคนระบุรายการนี้เมื่อ 3 ส.ค. 2569
 *
 * minutes = ต้องเปิดค้างกี่นาทีถึงจะได้ค่าที่เชื่อถือได้
 *   แอร์โกดัง 20 นาที  พื้นที่ใหญ่ กว่าคอมเพรสเซอร์จะเข้าสู่รอบเดินปกติใช้เวลานาน
 *   แอร์ห้อง  15 นาที  ห้องเล็ก ดึงอุณหภูมิลงเร็วกว่า
 *   พัดลม/ชาร์จรถ  โหลดคงที่ตั้งแต่วินาทีแรก ไม่ต้องรอ
 *
 * shedOrder = ลำดับที่ยอมให้ปิดตอนไฟเกิน (น้อย = ปิดก่อน)
 *   เรียงตามผลกระทบต่อคน ไม่ใช่ตาม kW: ชาร์จรถเลื่อนไปกลางคืนได้ไม่กระทบใคร
 *   ส่วนแอร์ห้องทำงานคือที่ที่มีคนนั่งอยู่จริง จึงอยู่ท้ายสุด
 *   พัดลมอยู่หลังแอร์ทั้งหมด เพราะเวลาปิดแอร์แล้วพัดลมคือสิ่งที่ทำให้ยังทนอยู่ได้
 *
 * protectedZone = ห้ามสั่งปิดเด็ดขาด (พ่อเต้ยระบุ: ไฟส่องสว่างปิดไม่ได้)
 */
export const ZONES = [
  // ไฟส่องสว่างแยกสองโซนเพราะกลางคืนโกดังปิดไฟหมด แต่ออฟฟิศยังเปิด
  // ถ้ารวมเป็นก้อนเดียว เส้นฐานกลางวันกับกลางคืนจะไม่เท่ากันโดยไม่มีใครรู้ว่าทำไม
  { slug: 'lighting',     name: 'ไฟส่องสว่างออฟฟิศ (ห้องทำงานเต้ย+มิ้ง+แอดมิน)', minutes: 10,
    shedOrder: null, protectedZone: true, baseline: true,
    note: 'เส้นฐานกลางคืน — เปิดค้างตลอด ปิดไม่ได้' },
  { slug: 'lighting-wh',  name: 'ไฟส่องสว่างโกดัง', minutes: 10,
    shedOrder: null, protectedZone: true, baseline: true,
    note: 'เปิดเฉพาะเวลาทำงาน ปิดไม่ได้ระหว่างมีคนทำงาน' },
  { slug: 'ev',           name: 'ชาร์จรถไฟฟ้า',          minutes: 10, shedOrder: 1,  owner: 'ใครก็ได้', note: 'เลื่อนไปชาร์จหลัง 22:00 ได้ ค่าไฟถูกกว่าด้วย' },
  { slug: 'air-dog',      name: 'แอร์ห้องหมา',            minutes: 15, shedOrder: 2,  owner: 'ใครก็ได้' },
  { slug: 'air-may',      name: 'แอร์ห้องนอนเมย์',        minutes: 15, shedOrder: 3,  owner: 'ใครก็ได้', note: 'กลางวันไม่มีคนนอน' },
  { slug: 'air-ming-bed', name: 'แอร์ห้องนอนมิ้ง',        minutes: 15, shedOrder: 4,  owner: 'ใครก็ได้', note: 'กลางวันไม่มีคนนอน' },
  { slug: 'air-w',        name: 'แอร์โกดังทิศตะวันตก',    minutes: 20, shedOrder: 5,  owner: 'พนักงานโกดัง' },
  { slug: 'air-s',        name: 'แอร์โกดังทิศใต้',        minutes: 20, shedOrder: 6,  owner: 'พนักงานโกดัง' },
  { slug: 'air-e',        name: 'แอร์โกดังทิศตะวันออก',   minutes: 20, shedOrder: 7,  owner: 'พนักงานโกดัง' },
  { slug: 'air-n',        name: 'แอร์โกดังทิศเหนือ',      minutes: 20, shedOrder: 8,  owner: 'พนักงานโกดัง' },
  { slug: 'air-ming',     name: 'แอร์ห้องทำงานมิ้ง',      minutes: 15, shedOrder: 9,  owner: 'มิ้ง', note: 'มีคนนั่งทำงานอยู่ ปิดเป็นลำดับท้าย ๆ' },
  { slug: 'air-toey',     name: 'แอร์ห้องทำงานเต้ย',      minutes: 15, shedOrder: 10, owner: 'เต้ย', note: 'มีคนนั่งทำงานอยู่ ปิดเป็นลำดับท้าย ๆ' },
  { slug: 'fans',         name: 'พัดลมทั้งโกดัง',         minutes: 5,  shedOrder: 11, owner: 'พนักงานโกดัง',
    note: 'ปิดเป็นอันสุดท้าย — เวลาปิดแอร์แล้ว พัดลมคือสิ่งที่ทำให้ยังทนทำงานได้' },
];

export const zoneBySlug = (slug) => ZONES.find((z) => z.slug === slug) || null;

/* ------------------------------------------------------- ค่าคงที่ของการวัด */

// ตัดกี่วินาทีแรกทิ้งตอนหาค่าเดินปกติ — วินาทีแรก ๆ คือกระแสกระชากตอนสตาร์ท
// ไม่ได้ตัดออกจากการหาพีค เพราะพีคคือสิ่งที่ทำให้ชนเพดาน demand จริง ๆ
const SETTLE_SEC = 60;
// หน้าต่างหาเส้นฐานก่อน/หลังการวัด
const BASE_WIN_SEC = 90;
// ถ้าเส้นฐานก่อนกับหลังต่างกันเกินนี้ แปลว่ามีอย่างอื่นเปิด/ปิดระหว่างวัด ค่าจะเพี้ยน
const DRIFT_WARN_KW = 0.4;
// ต้องมีจุดข้อมูลอย่างน้อยเท่านี้ถึงจะเชื่อผลได้ (5 วิ/จุด = 2 นาที)
const MIN_SAMPLES = 24;

/* --------------------------------------------------------------- ที่เก็บ */

/** สร้างตาราง — เรียกครั้งเดียวตอนเปิดเซิร์ฟเวอร์ */
export function initZoneTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS zone_tests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      zone       TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER,                 -- NULL = กำลังวัดอยู่
      status     TEXT NOT NULL,           -- running | done | cancelled
      note       TEXT,
      snapshot   TEXT                     -- ผลที่คำนวณไว้ตอนจบ (กัน readings ถูกลบทิ้ง)
    );
    CREATE INDEX IF NOT EXISTS zone_tests_zone ON zone_tests(zone, started_at);
  `);
}

/* --------------------------------------------------------- ตัวช่วยคำนวณ */

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/**
 * คำนวณผลของการวัดหนึ่งครั้งจากข้อมูลดิบ
 *
 * ใช้ median ไม่ใช่ค่าเฉลี่ยตอนหาเส้นฐาน เพราะถ้ามีใครเดินไปเปิดอะไรแวบเดียว
 * ค่าเฉลี่ยจะเขยิบตามทันที ส่วน median แทบไม่ขยับ
 *
 * @param store  Store — ใช้ดึง readings
 * @param test   แถวจาก zone_tests
 */
export function computeTest(store, test) {
  const zone = zoneBySlug(test.zone);
  const from = test.started_at;
  const to = test.ended_at || Date.now();

  // ดึงเผื่อหัวท้ายไว้หาเส้นฐาน
  const rows = store.all(from - BASE_WIN_SEC * 1000, to + BASE_WIN_SEC * 1000);
  const inWin = rows.filter((r) => r.t >= from && r.t <= to);
  const before = rows.filter((r) => r.t < from).map((r) => r.load);
  const after = rows.filter((r) => r.t > to).map((r) => r.load);

  const baseBefore = median(before);
  const baseAfter = after.length >= 6 ? median(after) : null;
  // ถ้าไม่มีข้อมูลก่อนหน้าเลย (เพิ่งเปิดเครื่อง) ใช้จุดต่ำสุดในช่วงแทน ดีกว่าไม่มีอะไรเลย
  const base = baseBefore ?? (inWin.length ? Math.min(...inWin.map((r) => r.load)) : 0);

  const loads = inWin.map((r) => r.load);
  const durationSec = Math.round((to - from) / 1000);

  // ค่าเดินปกติ: ตัดช่วงสตาร์ททิ้ง แล้วเอา median ของหนึ่งในสามท้าย
  // ท้ายช่วงคือตอนที่ระบบเข้าที่แล้ว ซึ่งเป็นค่าที่มันจะเป็นตลอดทั้งวัน
  const settled = inWin.filter((r) => r.t >= from + SETTLE_SEC * 1000);
  const tailFrom = settled.length ? settled[Math.floor(settled.length * (2 / 3))].t : from;
  const tail = settled.filter((r) => r.t >= tailFrom).map((r) => r.load);

  const peakRow = inWin.reduce((best, r) => (!best || r.load > best.load ? r : best), null);
  const steadyAbs = median(tail);
  const avgAbs = mean(loads);

  // โซนเส้นฐาน (ไฟส่องสว่าง) ไม่ต้องลบอะไร ตัวมันเองคือฐาน
  const isBase = !!zone?.baseline;
  const sub = (v) => (v === null ? null : round2(isBase ? v : v - base));

  const drift = baseAfter === null || baseBefore === null ? null : round2(baseAfter - baseBefore);

  const warnings = [];
  if (inWin.length < MIN_SAMPLES) warnings.push(`ข้อมูลน้อยไป (${inWin.length} จุด) — เปิดค้างให้นานกว่านี้`);
  if (zone && durationSec < zone.minutes * 60 * 0.8) {
    warnings.push(`เปิดไม่ครบเวลาที่แนะนำ (${Math.round(durationSec / 60)} จาก ${zone.minutes} นาที) ค่าอาจสูงกว่าจริง`);
  }
  if (drift !== null && Math.abs(drift) > DRIFT_WARN_KW) {
    warnings.push(`เส้นฐานก่อน/หลังต่างกัน ${drift > 0 ? '+' : ''}${drift} kW — น่าจะมีอย่างอื่นเปิดหรือปิดระหว่างวัด`);
  }
  if (!isBase && steadyAbs !== null && steadyAbs - base < 0.15) {
    warnings.push('แทบไม่เห็นความต่าง — ตรวจดูว่าเปิดโซนนั้นจริงหรือยัง');
  }

  return {
    id: test.id,
    zone: test.zone,
    name: zone?.name || test.zone,
    startedAt: from,
    endedAt: test.ended_at,
    status: test.status,
    note: test.note || null,
    durationSec,
    samples: inWin.length,
    baselineKw: round2(base),
    baselineAfterKw: baseAfter === null ? null : round2(baseAfter),
    driftKw: drift,
    // ตัวเลขที่ใช้จริง — kW ที่โซนนี้กิน
    steadyKw: sub(steadyAbs),   // เดินปกติ ใช้คิดค่าไฟและใช้ตัดสินใจว่าปิดแล้วได้เท่าไร
    peakKw: sub(peakRow?.load ?? null), // สูงสุดที่เคยเห็น ใช้ระวังเรื่องพีค demand
    avgKw: sub(avgAbs),
    peakAt: peakRow?.t ?? null,
    warnings,
  };
}

/* ------------------------------------------------------- คำสั่งที่เรียกใช้ */

export class Zones {
  constructor(store, log) {
    this.store = store;
    this.db = store.db;
    this.log = log || (() => {});
    initZoneTables(this.db);
  }

  /** การวัดที่ยังไม่จบ (มีได้ทีละอันเท่านั้น — วัดพร้อมกันสองโซนแยกกันไม่ออก) */
  running() {
    const row = this.db.prepare("SELECT * FROM zone_tests WHERE status = 'running' ORDER BY started_at DESC").get();
    return row || null;
  }

  start(slug, at = Date.now()) {
    const zone = zoneBySlug(slug);
    if (!zone) throw new Error(`ไม่รู้จักโซน "${slug}"`);
    const cur = this.running();
    if (cur) throw new Error(`กำลังวัด "${zoneBySlug(cur.zone)?.name || cur.zone}" อยู่ ต้องจบอันนั้นก่อน`);

    const r = this.db
      .prepare("INSERT INTO zone_tests (zone, started_at, status) VALUES (?, ?, 'running')")
      .run(slug, Math.round(at));
    this.log(`เริ่มวัดโซน "${zone.name}" — ให้เปิดค้าง ${zone.minutes} นาที`);
    return this.byId(Number(r.lastInsertRowid));
  }

  /** จบการวัด แล้วคำนวณ + เก็บ snapshot ไว้ */
  stop(note = '', at = Date.now()) {
    const cur = this.running();
    if (!cur) throw new Error('ตอนนี้ไม่ได้วัดอะไรอยู่');
    this.db
      .prepare("UPDATE zone_tests SET ended_at = ?, status = 'done', note = ? WHERE id = ?")
      .run(Math.round(at), note || null, cur.id);

    const row = this.db.prepare('SELECT * FROM zone_tests WHERE id = ?').get(cur.id);
    const result = computeTest(this.store, row);
    this.db.prepare('UPDATE zone_tests SET snapshot = ? WHERE id = ?').run(JSON.stringify(result), cur.id);
    this.log(`จบการวัด "${result.name}" — เดินปกติ ${result.steadyKw} kW / พีค ${result.peakKw} kW`);
    return result;
  }

  cancel() {
    const cur = this.running();
    if (!cur) return null;
    this.db.prepare("UPDATE zone_tests SET status = 'cancelled', ended_at = ? WHERE id = ?").run(Date.now(), cur.id);
    this.log(`ยกเลิกการวัด "${zoneBySlug(cur.zone)?.name || cur.zone}"`);
    return cur.id;
  }

  byId(id) {
    const row = this.db.prepare('SELECT * FROM zone_tests WHERE id = ?').get(id);
    return row ? computeTest(this.store, row) : null;
  }

  /** ผลทุกครั้งของโซนหนึ่ง ใหม่ก่อน */
  history(slug) {
    const rows = this.db
      .prepare("SELECT * FROM zone_tests WHERE zone = ? AND status = 'done' ORDER BY started_at DESC")
      .all(slug);
    return rows.map((r) => this._resultOf(r));
  }

  /**
   * ผลล่าสุดของทุกโซน — นี่คือสิ่งที่ระบบเอาไปใช้ตัดสินใจว่าจะให้ปิดอะไร
   *
   * ใช้ "ครั้งล่าสุด" ไม่ใช่ค่าเฉลี่ยของทุกครั้ง เพราะถ้าวัดซ้ำแปลว่าครั้งก่อน
   * มีอะไรไม่ถูก (เปิดผิดตัว เวลาไม่พอ) การเอามาเฉลี่ยรวมคือเอาค่าที่รู้ว่าผิด
   * มาถ่วงค่าที่ถูก
   */
  latestAll() {
    const out = {};
    for (const z of ZONES) {
      const row = this.db
        .prepare("SELECT * FROM zone_tests WHERE zone = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1")
        .get(z.slug);
      out[z.slug] = row ? this._resultOf(row) : null;
    }
    return out;
  }

  /** คำนวณสด ถ้าข้อมูลดิบถูกลบไปแล้วค่อยใช้ snapshot ที่เก็บไว้ */
  _resultOf(row) {
    const live = computeTest(this.store, row);
    if (live.samples >= MIN_SAMPLES) return live;
    if (row.snapshot) {
      try { return { ...JSON.parse(row.snapshot), fromSnapshot: true }; } catch { /* พังก็ใช้ค่าสด */ }
    }
    return live;
  }

  /** สรุปทั้งหน้า สำหรับ /api/zones */
  overview(cfg) {
    const latest = this.latestAll();
    const cur = this.running();

    const zones = ZONES.map((z) => {
      const r = latest[z.slug];
      return {
        slug: z.slug,
        name: z.name,
        minutes: z.minutes,
        shedOrder: z.shedOrder,
        protectedZone: !!z.protectedZone,
        baseline: !!z.baseline,
        owner: z.owner || null,
        note: z.note || null,
        measured: r
          ? {
              steadyKw: r.steadyKw,
              peakKw: r.peakKw,
              avgKw: r.avgKw,
              at: r.startedAt,
              durationSec: r.durationSec,
              warnings: r.warnings,
            }
          : null,
      };
    });

    const measured = zones.filter((z) => z.measured && !z.baseline);
    const shedable = measured.filter((z) => !z.protectedZone);

    return {
      zones,
      running: cur
        ? {
            id: cur.id,
            zone: cur.zone,
            name: zoneBySlug(cur.zone)?.name || cur.zone,
            startedAt: cur.started_at,
            minutes: zoneBySlug(cur.zone)?.minutes || 15,
            live: computeTest(this.store, cur),
          }
        : null,
      // เส้นฐาน = ไฟส่องสว่างทุกโซนรวมกัน (ออฟฟิศเปิดตลอด โกดังเปิดเฉพาะเวลาทำงาน)
      baselineKw: sumBaselines(latest),
      baselineParts: ZONES.filter((z) => z.baseline).map((z) => ({
        slug: z.slug, name: z.name, kw: latest[z.slug]?.steadyKw ?? null,
      })),
      totalShedableKw: round1(shedable.reduce((s, z) => s + (z.measured.steadyKw || 0), 0)),
      doneCount: measured.length,
      totalCount: ZONES.filter((z) => !z.baseline).length,
      nextSuggestion: nextToMeasure(zones),
      shedList: buildShedList(this),
    };
  }
}

/** ไฟส่องสว่างทุกโซนรวมกัน — null ถ้ายังไม่เคยวัดสักโซน */
function sumBaselines(latest) {
  const vals = ZONES.filter((z) => z.baseline).map((z) => latest[z.slug]?.steadyKw).filter((v) => typeof v === 'number');
  return vals.length ? round1(vals.reduce((a, b) => a + b, 0)) : null;
}

/** โซนถัดไปที่ควรวัด — ไล่ตามลำดับในรายการ ข้ามตัวที่วัดแล้ว */
function nextToMeasure(zones) {
  const z = zones.find((x) => !x.measured);
  return z ? { slug: z.slug, name: z.name, minutes: z.minutes } : null;
}

/**
 * แปลงผลที่วัดได้เป็น "รายการให้ไปปิด" ที่ระบบเตือนใช้อยู่แล้ว
 *
 * เรียงตาม shedOrder (ผลกระทบต่อคนน้อยสุดก่อน) ไม่ใช่เรียงตาม kW มากสุดก่อน
 * เพราะการปิดแอร์ห้องที่มีคนนั่งทำงานอยู่เพื่อประหยัดไฟ 3 kW ทั้งที่ยังมี
 * ที่ชาร์จรถเปิดค้างอยู่ ไม่ใช่คำแนะนำที่ใครจะทำตาม
 *
 * โซนที่ยังไม่ได้วัดจะไม่เข้ารายการ — ไม่เดาตัวเลขให้คนไปทำตาม
 */
export function buildShedList(zones) {
  const latest = zones.latestAll();
  return ZONES.filter((z) => !z.protectedZone && z.shedOrder !== null)
    .filter((z) => latest[z.slug]?.steadyKw > 0)
    .sort((a, b) => a.shedOrder - b.shedOrder)
    .map((z) => ({
      name: z.name,
      kw: round1(latest[z.slug].steadyKw),
      owner: z.owner || null,
      order: z.shedOrder,
      slug: z.slug,
      measuredAt: latest[z.slug].startedAt,
    }));
}
