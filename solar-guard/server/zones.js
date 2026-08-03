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
 * รายการโซนตั้งต้น — พ่อเต้ยเป็นคนระบุเมื่อ 3 ส.ค. 2569
 *
 * ใช้แค่ตอนสร้างฐานข้อมูลครั้งแรกเท่านั้น หลังจากนั้นรายการจริงอยู่ในตาราง
 * zone_defs และแก้ได้จากหน้าจอ (โรงงานซื้อของเพิ่มได้ตลอด ถ้าต้องมาแก้โค้ด
 * ทุกครั้งที่ซื้อแอร์เพิ่มหนึ่งตัว สุดท้ายก็จะไม่มีใครแก้ แล้วรายการก็จะไม่ตรง)
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
export const DEFAULT_ZONES = [
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

/** ตัวช่วยเล็ก ๆ ที่ใช้ทั้งไฟล์ */
const clean = (s) => String(s ?? '').trim();
const numOr = (v, d) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

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

/** สร้างตาราง + ใส่รายการตั้งต้นถ้ายังว่าง — เรียกครั้งเดียวตอนเปิดเซิร์ฟเวอร์ */
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

    CREATE TABLE IF NOT EXISTS zone_defs (
      slug        TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      minutes     INTEGER NOT NULL DEFAULT 15,
      shed_order  INTEGER,                -- NULL = ไม่อยู่ในรายการที่สั่งปิดได้
      protected   INTEGER NOT NULL DEFAULT 0,
      is_baseline INTEGER NOT NULL DEFAULT 0,
      owner       TEXT,
      note        TEXT,
      sort        INTEGER NOT NULL DEFAULT 0,
      -- ลบแบบซ่อน ไม่ลบจริง เพราะผลวัดเก่ายังอ้างถึงโซนนี้อยู่
      -- ถ้าลบทิ้งจริง ประวัติจะกลายเป็นแถวที่ไม่รู้ว่าของอะไร
      active      INTEGER NOT NULL DEFAULT 1
    );
  `);

  // เพิ่มคอลัมน์ทีหลังแบบไม่ทำลายของเดิม (SQLite ไม่มี ADD COLUMN IF NOT EXISTS)
  //
  // base_mode = เทียบกับอะไร
  //   auto  ค่าก่อนกดเริ่ม 90 วินาที — ใช้เมื่อกดเริ่มก่อนแล้วค่อยไปเปิดเครื่อง
  //   fixed ค่าที่ระบุมา — ใช้เมื่อเครื่องเปิดค้างอยู่ก่อนแล้วค่อยมากด ซึ่งกรณีนั้น
  //         ค่าก่อนกดเริ่มมีโหลดตัวที่กำลังจะวัดรวมอยู่แล้ว เทียบไปก็ได้ศูนย์
  // confirmed = คนยืนยันเองว่าผลนี้ใช้ได้ แม้ระบบจะคิดว่าข้อมูลสั้นไป
  const cols = db.prepare('PRAGMA table_info(zone_tests)').all().map((c) => c.name);
  if (!cols.includes('base_mode')) db.exec("ALTER TABLE zone_tests ADD COLUMN base_mode TEXT NOT NULL DEFAULT 'auto'");
  if (!cols.includes('base_kw')) db.exec('ALTER TABLE zone_tests ADD COLUMN base_kw REAL');
  if (!cols.includes('confirmed')) db.exec('ALTER TABLE zone_tests ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0');

  const n = db.prepare('SELECT count(*) c FROM zone_defs').get().c;
  if (n === 0) {
    const ins = db.prepare(`INSERT INTO zone_defs
      (slug,name,minutes,shed_order,protected,is_baseline,owner,note,sort)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    DEFAULT_ZONES.forEach((z, i) => ins.run(
      z.slug, z.name, z.minutes, z.shedOrder ?? null,
      z.protectedZone ? 1 : 0, z.baseline ? 1 : 0,
      z.owner || null, z.note || null, i,
    ));
  }
}

/** แถวในฐานข้อมูล -> รูปแบบที่โค้ดส่วนอื่นใช้ */
function rowToZone(r) {
  return {
    slug: r.slug,
    name: r.name,
    minutes: r.minutes,
    shedOrder: r.shed_order,
    protectedZone: !!r.protected,
    baseline: !!r.is_baseline,
    owner: r.owner || null,
    note: r.note || null,
    sort: r.sort,
    active: !!r.active,
  };
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
 * @param zone   นิยามโซน (จากตาราง zone_defs) — null ได้ถ้าโซนถูกลบไปแล้ว
 */
export function computeTest(store, test, zone = null) {
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
  const autoBase = baseBefore ?? (inWin.length ? Math.min(...inWin.map((r) => r.load)) : 0);

  // เปิดเครื่องค้างไว้ก่อนแล้วค่อยมากดวัด = ค่าก่อนกดเริ่มมีโหลดตัวนั้นรวมอยู่แล้ว
  // เทียบกับมันตรง ๆ จะได้ศูนย์ทุกครั้ง จึงต้องเทียบกับเส้นฐานที่บันทึกไว้แทน
  const fixedBase = test.base_mode === 'fixed' && test.base_kw !== null && test.base_kw !== undefined
    ? Number(test.base_kw) : null;
  const base = fixedBase ?? autoBase;

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

  // โซนเส้นฐานตัวแรก (ไฟส่องสว่างออฟฟิศที่เปิดตอนไม่มีอะไรอื่นเลย) ไม่ต้องลบอะไร
  // แต่ถ้าระบุเส้นฐานมาเอง แปลว่ามีของอื่นเปิดอยู่ด้วย ต้องลบออกเหมือนโซนทั่วไป
  const isBase = !!zone?.baseline && fixedBase === null;
  const sub = (v) => (v === null ? null : round2(isBase ? v : v - base));

  const drift = baseAfter === null || baseBefore === null ? null : round2(baseAfter - baseBefore);

  // เปิดค้างมาก่อนแล้ว = ไม่มีช่วงกินไฟสูงตอนสตาร์ทให้ต้องรอ เวลาสั้นจึงไม่ใช่ปัญหา
  const preRunning = fixedBase !== null;
  const confirmed = !!test.confirmed;

  const warnings = [];
  if (inWin.length < MIN_SAMPLES) warnings.push(`ข้อมูลน้อยไป (${inWin.length} จุด) — เปิดค้างให้นานกว่านี้`);
  if (!preRunning && zone && durationSec < zone.minutes * 60 * 0.8) {
    warnings.push(`เปิดไม่ครบเวลาที่แนะนำ (${Math.round(durationSec / 60)} จาก ${zone.minutes} นาที) ค่าอาจสูงกว่าจริง`);
  }
  if (drift !== null && Math.abs(drift) > DRIFT_WARN_KW) {
    warnings.push(`เส้นฐานก่อน/หลังต่างกัน ${drift > 0 ? '+' : ''}${drift} kW — น่าจะมีอย่างอื่นเปิดหรือปิดระหว่างวัด`);
  }
  if (!isBase && steadyAbs !== null && steadyAbs - base < 0.15) {
    warnings.push('แทบไม่เห็นความต่าง — ตรวจดูว่าเปิดโซนนั้นจริงหรือยัง');
  }

  // "ใช้ได้จริงไหม" — ต้องแยกจาก "วัดจบแล้ว"
  //
  // การวัดที่จบแล้วแต่ข้อมูลน้อยเกินไปหรือได้ค่าติดลบ (ลืมเปิดเครื่อง เปิดผิดตัว
  // หรือมีอย่างอื่นปิดไประหว่างนั้น) ต้องไม่ถูกนับว่าโซนนั้นวัดเสร็จแล้ว
  // ไม่งั้นหน้าจอจะบอกว่าครบแล้วทั้งที่ตัวเลขใช้ไม่ได้ แล้วไม่มีใครกลับมาวัดซ้ำ
  // คนกดยืนยันเองได้ ระบบไม่ใช่คนที่รู้ดีที่สุดเสมอ — คนที่ยืนอยู่หน้าเครื่องรู้ว่า
  // เพิ่งเปิดหรือเปิดค้างมาทั้งวัน แต่ต้องมีตัวเลขที่เป็นบวกจริงถึงจะยืนยันได้
  const hasValue = typeof steadyAbs === 'number' && (isBase ? steadyAbs > 0.1 : steadyAbs - base > 0.1);
  const enoughData = inWin.length >= (preRunning ? 6 : MIN_SAMPLES);
  const usable = hasValue && (enoughData || confirmed);

  return {
    id: test.id,
    zone: test.zone,
    name: zone?.name || test.zone,
    usable,
    confirmed,
    preRunning,
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

  /* ---------------------------------------------------- รายการโซน (แก้ได้) */

  /** โซนทั้งหมดที่ยังใช้งานอยู่ เรียงตามลำดับที่ตั้งไว้ */
  list(includeRemoved = false) {
    const sql = includeRemoved
      ? 'SELECT * FROM zone_defs ORDER BY sort, slug'
      : 'SELECT * FROM zone_defs WHERE active = 1 ORDER BY sort, slug';
    return this.db.prepare(sql).all().map(rowToZone);
  }

  /** นิยามของโซนหนึ่ง — หาแม้โซนถูกซ่อนไปแล้ว เพราะประวัติเก่ายังต้องรู้ชื่อ */
  def(slug) {
    const r = this.db.prepare('SELECT * FROM zone_defs WHERE slug = ?').get(slug);
    return r ? rowToZone(r) : null;
  }

  /**
   * เพิ่มโซนใหม่ หรือแก้โซนเดิม
   *
   * slug สร้างอัตโนมัติจากเวลา ไม่ให้คนต้องคิดรหัสภาษาอังกฤษเอง — ชื่อไทยแปลงเป็น
   * slug ที่อ่านออกไม่ได้อยู่แล้ว และถ้าให้พิมพ์เองก็จะซ้ำกันจนทับข้อมูลเก่า
   */
  saveZone(input) {
    const name = clean(input.name);
    if (!name) throw new Error('ต้องใส่ชื่อโซน');

    const minutes = Math.max(1, Math.min(120, numOr(input.minutes, 15)));
    const isProtected = !!input.protectedZone;
    const isBaseline = !!input.baseline;
    const owner = clean(input.owner) || null;
    const note = clean(input.note) || null;
    const slug = clean(input.slug);

    if (slug) {
      const cur = this.def(slug);
      if (!cur) throw new Error(`ไม่รู้จักโซน "${slug}"`);
      // โซนที่ห้ามปิดต้องไม่มีลำดับการปิดค้างอยู่ ไม่งั้นสองค่านี้จะขัดกันเอง
      const order = isProtected ? null : numOr(input.shedOrder, cur.shedOrder);
      this.db.prepare(`UPDATE zone_defs SET name=?, minutes=?, shed_order=?, protected=?,
                       is_baseline=?, owner=?, note=? WHERE slug=?`)
        .run(name, minutes, order, isProtected ? 1 : 0, isBaseline ? 1 : 0, owner, note, slug);
      this.log(`แก้โซน "${name}"`);
      return this.def(slug);
    }

    // เติมตัวนับต่อท้ายถ้าชนกัน — เพิ่มสองโซนรวดเดียวจะได้เวลาเดียวกันเป๊ะ
    let newSlug = 'z-' + Date.now().toString(36);
    for (let i = 2; this.def(newSlug); i++) newSlug = 'z-' + Date.now().toString(36) + '-' + i;
    const maxSort = this.db.prepare('SELECT max(sort) m FROM zone_defs').get().m ?? 0;
    // โซนใหม่ต่อท้ายลำดับการปิด = ปิดเป็นอันหลังสุด จนกว่าจะมีคนบอกว่าควรอยู่ตรงไหน
    // ปลอดภัยกว่าเดาให้ปิดก่อน เพราะระบบยังไม่รู้ว่าปิดตัวนี้แล้วกระทบใคร
    const maxOrder = this.db.prepare('SELECT max(shed_order) m FROM zone_defs').get().m ?? 0;
    const order = isProtected ? null : numOr(input.shedOrder, maxOrder + 1);

    this.db.prepare(`INSERT INTO zone_defs
      (slug,name,minutes,shed_order,protected,is_baseline,owner,note,sort)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(newSlug, name, minutes, order, isProtected ? 1 : 0, isBaseline ? 1 : 0, owner, note, maxSort + 1);
    this.log(`เพิ่มโซนใหม่ "${name}" (เปิดค้าง ${minutes} นาที)`);
    return this.def(newSlug);
  }

  /** ซ่อนโซน — ไม่ลบจริง ผลวัดเก่ายังอยู่ครบและกู้กลับได้ */
  removeZone(slug) {
    const z = this.def(slug);
    if (!z) throw new Error(`ไม่รู้จักโซน "${slug}"`);
    const cur = this.running();
    if (cur && cur.zone === slug) throw new Error('โซนนี้กำลังวัดอยู่ ต้องจบหรือทิ้งการวัดก่อน');
    this.db.prepare('UPDATE zone_defs SET active = 0 WHERE slug = ?').run(slug);
    this.log(`เอาโซน "${z.name}" ออกจากรายการ (ผลวัดเก่ายังเก็บไว้)`);
    return true;
  }

  restoreZone(slug) {
    this.db.prepare('UPDATE zone_defs SET active = 1 WHERE slug = ?').run(slug);
    return this.def(slug);
  }

  /**
   * เลื่อนลำดับการปิดขึ้น/ลงหนึ่งขั้น
   *
   * สลับเลขกับเพื่อนบ้านแทนการเขียนลำดับใหม่ทั้งชุด — ลำดับของโซนอื่นจะได้ไม่ขยับ
   * ตามไปด้วยโดยไม่มีใครสั่ง
   */
  moveShedOrder(slug, dir) {
    const z = this.def(slug);
    if (!z) throw new Error(`ไม่รู้จักโซน "${slug}"`);
    if (z.protectedZone || z.shedOrder === null) throw new Error('โซนนี้ปิดไม่ได้ จึงไม่มีลำดับการปิด');

    const neighbour = this.db.prepare(
      dir === 'up'
        ? 'SELECT * FROM zone_defs WHERE active=1 AND shed_order IS NOT NULL AND shed_order < ? ORDER BY shed_order DESC LIMIT 1'
        : 'SELECT * FROM zone_defs WHERE active=1 AND shed_order IS NOT NULL AND shed_order > ? ORDER BY shed_order ASC LIMIT 1',
    ).get(z.shedOrder);
    if (!neighbour) return this.list();

    const upd = this.db.prepare('UPDATE zone_defs SET shed_order = ? WHERE slug = ?');
    upd.run(neighbour.shed_order, z.slug);
    upd.run(z.shedOrder, neighbour.slug);
    return this.list();
  }

  /* ------------------------------------------------------------ การวัดผล */

  /** การวัดที่ยังไม่จบ (มีได้ทีละอันเท่านั้น — วัดพร้อมกันสองโซนแยกกันไม่ออก) */
  running() {
    const row = this.db.prepare("SELECT * FROM zone_tests WHERE status = 'running' ORDER BY started_at DESC").get();
    return row || null;
  }

  /**
   * เส้นฐานที่บันทึกไว้ = ผลรวมโซนพื้นฐานที่วัดแล้ว (ไฟส่องสว่าง)
   * ใช้ตอนวัดของที่เปิดค้างอยู่ก่อนแล้ว
   */
  savedBaselineKw() {
    return sumBaselines(this.list(), this.latestAll());
  }

  start(slug, { at = Date.now(), preRunning = false } = {}) {
    const zone = this.def(slug);
    if (!zone) throw new Error(`ไม่รู้จักโซน "${slug}"`);
    const cur = this.running();
    if (cur) throw new Error(`กำลังวัด "${this.def(cur.zone)?.name || cur.zone}" อยู่ ต้องจบอันนั้นก่อน`);

    const baseKw = preRunning ? this.savedBaselineKw() : null;
    if (preRunning && baseKw === null) {
      throw new Error('ยังไม่มีเส้นฐานที่บันทึกไว้ — ต้องวัดไฟส่องสว่างก่อน ถึงจะวัดของที่เปิดค้างอยู่ได้');
    }

    const r = this.db
      .prepare("INSERT INTO zone_tests (zone, started_at, status, base_mode, base_kw) VALUES (?,?,'running',?,?)")
      .run(slug, Math.round(at), preRunning ? 'fixed' : 'auto', baseKw);
    this.log(preRunning
      ? `เริ่มวัดโซน "${zone.name}" (เปิดค้างอยู่ก่อนแล้ว เทียบกับเส้นฐาน ${baseKw} kW)`
      : `เริ่มวัดโซน "${zone.name}" — ให้เปิดค้าง ${zone.minutes} นาที`);
    return this.byId(Number(r.lastInsertRowid));
  }

  /** คนยืนยันเองว่าผลนี้ใช้ได้ แม้ข้อมูลจะสั้นกว่าที่ระบบอยากได้ */
  confirm(id) {
    const row = this.db.prepare('SELECT * FROM zone_tests WHERE id = ?').get(Number(id));
    if (!row) throw new Error('ไม่พบผลการวัดนี้');
    this.db.prepare('UPDATE zone_tests SET confirmed = 1 WHERE id = ?').run(row.id);
    const result = computeTest(this.store, { ...row, confirmed: 1 }, this.def(row.zone));
    this.db.prepare('UPDATE zone_tests SET snapshot = ? WHERE id = ?').run(JSON.stringify(result), row.id);
    this.log(`ยืนยันผลการวัด "${result.name}" ด้วยตัวเอง — ${result.steadyKw} kW`);
    return result;
  }

  /** จบการวัด แล้วคำนวณ + เก็บ snapshot ไว้ */
  stop(note = '', at = Date.now()) {
    const cur = this.running();
    if (!cur) throw new Error('ตอนนี้ไม่ได้วัดอะไรอยู่');
    this.db
      .prepare("UPDATE zone_tests SET ended_at = ?, status = 'done', note = ? WHERE id = ?")
      .run(Math.round(at), note || null, cur.id);

    const row = this.db.prepare('SELECT * FROM zone_tests WHERE id = ?').get(cur.id);
    const result = computeTest(this.store, row, this.def(row.zone));
    this.db.prepare('UPDATE zone_tests SET snapshot = ? WHERE id = ?').run(JSON.stringify(result), cur.id);
    this.log(`จบการวัด "${result.name}" — เดินปกติ ${result.steadyKw} kW / พีค ${result.peakKw} kW`);
    return result;
  }

  /**
   * บันทึกย้อนหลัง — "ช่วง X ถึง Y ที่ผ่านมา เปิดโซนนี้อยู่"
   *
   * มีเพราะคนเปิดเครื่องก่อนแล้วค่อยนึกได้ว่าต้องกดจับเวลา ถ้าไม่มีทางนี้
   * ก็ต้องไปปิดแล้วเปิดใหม่รอบหนึ่งเปล่า ๆ ทั้งที่ข้อมูลดิบเก็บไว้ครบอยู่แล้ว
   */
  record(slug, from, to, note = '', preRunning = false) {
    const zone = this.def(slug);
    if (!zone) throw new Error(`ไม่รู้จักโซน "${slug}"`);
    if (!(to > from)) throw new Error('ช่วงเวลาไม่ถูกต้อง');
    const baseKw = preRunning ? this.savedBaselineKw() : null;
    const r = this.db
      .prepare(`INSERT INTO zone_tests (zone, started_at, ended_at, status, note, base_mode, base_kw)
                VALUES (?,?,?,'done',?,?,?)`)
      .run(slug, Math.round(from), Math.round(to), note || null, preRunning ? 'fixed' : 'auto', baseKw);

    const row = this.db.prepare('SELECT * FROM zone_tests WHERE id = ?').get(Number(r.lastInsertRowid));
    const result = computeTest(this.store, row, this.def(row.zone));
    this.db.prepare('UPDATE zone_tests SET snapshot = ? WHERE id = ?').run(JSON.stringify(result), row.id);
    this.log(`บันทึกย้อนหลัง "${result.name}" — เดินปกติ ${result.steadyKw} kW / พีค ${result.peakKw} kW`);
    return result;
  }

  cancel() {
    const cur = this.running();
    if (!cur) return null;
    this.db.prepare("UPDATE zone_tests SET status = 'cancelled', ended_at = ? WHERE id = ?").run(Date.now(), cur.id);
    this.log(`ยกเลิกการวัด "${this.def(cur.zone)?.name || cur.zone}"`);
    return cur.id;
  }

  byId(id) {
    const row = this.db.prepare('SELECT * FROM zone_tests WHERE id = ?').get(id);
    return row ? computeTest(this.store, row, this.def(row.zone)) : null;
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
    for (const z of this.list()) {
      // ไล่จากใหม่ไปเก่า เอาครั้งล่าสุดที่ผลใช้ได้จริง
      //
      // ถ้าเอาครั้งล่าสุดดื้อ ๆ การกดวัดพลาดครั้งเดียว (ลืมเปิดเครื่อง กดจบเร็วไป)
      // จะลบค่าดีที่วัดมาอย่างดีทิ้งไปเลย ทั้งที่ยังอยู่ในฐานข้อมูลครบ
      const rows = this.db
        .prepare("SELECT * FROM zone_tests WHERE zone = ? AND status = 'done' ORDER BY started_at DESC LIMIT 10")
        .all(z.slug);
      let pick = null;
      for (const row of rows) {
        const r = this._resultOf(row);
        if (!pick) pick = r;          // เก็บครั้งล่าสุดไว้ก่อน เผื่อไม่มีอันไหนใช้ได้เลย
        if (r.usable) { pick = r; break; }
      }
      out[z.slug] = pick;
    }
    return out;
  }

  /** คำนวณสด ถ้าข้อมูลดิบถูกลบไปแล้วค่อยใช้ snapshot ที่เก็บไว้ */
  _resultOf(row) {
    const live = computeTest(this.store, row, this.def(row.zone));
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
    const defs = this.list();

    const zones = defs.map((z) => {
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
        measured: r && r.usable
          ? {
              steadyKw: r.steadyKw,
              peakKw: r.peakKw,
              avgKw: r.avgKw,
              at: r.startedAt,
              durationSec: r.durationSec,
              warnings: r.warnings,
            }
          : null,
        // วัดไปแล้วแต่ผลใช้ไม่ได้ — ต้องบอกให้เห็น ไม่ใช่ทำเหมือนไม่เคยวัด
        // ส่ง id มาด้วย เผื่อคนดูแล้วรู้ว่าค่าถูกอยู่แล้วจะได้กดยืนยันได้
        failed: r && !r.usable
          ? { id: r.id, at: r.startedAt, warnings: r.warnings, steadyKw: r.steadyKw, samples: r.samples }
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
            name: this.def(cur.zone)?.name || cur.zone,
            startedAt: cur.started_at,
            minutes: this.def(cur.zone)?.minutes || 15,
            live: computeTest(this.store, cur, this.def(cur.zone)),
          }
        : null,
      // เส้นฐาน = ไฟส่องสว่างทุกโซนรวมกัน (ออฟฟิศเปิดตลอด โกดังเปิดเฉพาะเวลาทำงาน)
      baselineKw: sumBaselines(defs, latest),
      baselineParts: defs.filter((z) => z.baseline).map((z) => ({
        slug: z.slug, name: z.name, kw: latest[z.slug]?.usable ? latest[z.slug].steadyKw : null,
      })),
      totalShedableKw: round1(shedable.reduce((s, z) => s + (z.measured.steadyKw || 0), 0)),
      doneCount: measured.length,
      totalCount: defs.filter((z) => !z.baseline).length,
      nextSuggestion: nextToMeasure(zones),
      shedList: buildShedList(this),
      removedZones: this.list(true).filter((z) => !z.active).map((z) => ({ slug: z.slug, name: z.name })),
    };
  }
}

/** ไฟส่องสว่างทุกโซนรวมกัน — null ถ้ายังไม่เคยวัดสักโซน */
function sumBaselines(defs, latest) {
  const vals = defs.filter((z) => z.baseline)
    .map((z) => (latest[z.slug]?.usable ? latest[z.slug].steadyKw : null))
    .filter((v) => typeof v === 'number');
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
  return zones.list().filter((z) => !z.protectedZone && z.shedOrder !== null)
    .filter((z) => latest[z.slug]?.usable && latest[z.slug].steadyKw > 0)
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
