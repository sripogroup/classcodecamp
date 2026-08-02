/**
 * แหล่งข้อมูลทางเลือก: Kiosk View ของ FusionSolar
 *
 * ข้อดี: เป็น URL สาธารณะ ไม่ต้องมีบัญชี Northbound API ไม่ต้องเก็บรหัสผ่านไว้ที่ไหนเลย
 * ข้อเสียที่ต้องรู้:
 *   - URL หมดอายุทุก 1 ปี ต้องต่ออายุ ไม่งั้นระบบจะเงียบไปเฉย ๆ
 *   - ใครมีลิงก์ก็เปิดดูได้
 *   - **ยังไม่ยืนยันว่ามีข้อมูลฝั่งใช้ไฟ (ซื้อไฟ/โหลดรวม) หรือไม่** ซึ่งเป็นตัวที่ระบบนี้ต้องใช้
 *
 * เพราะข้อสุดท้ายยังไม่รู้ ไฟล์นี้จึงออกแบบให้ "ไปค้นหาเอง" แทนที่จะเดาชื่อฟิลด์:
 * ดึงข้อมูลมาแล้วไล่ดูทุกชั้นของ JSON หาค่าตัวเลขทั้งหมด แล้วค่อยจับคู่
 * ใช้คู่กับ /api/probe-kiosk ที่จะโชว์ทุกฟิลด์ที่มีจริง ๆ ออกมาให้ดู
 */

/** ประกอบ URL ของ REST endpoint ที่หน้า Kiosk เรียกอยู่เบื้องหลัง */
export function kioskApiUrl(cfg) {
  const base = (cfg.kioskBase || cfg.fusionBase).replace(/\/+$/, '');
  return `${base}/rest/pvms/web/kiosk/v1/station-kiosk-file?kk=${encodeURIComponent(cfg.kioskKey)}`;
}

/** ดึงข้อมูลดิบ — FusionSolar ห่อ data เป็นสตริง JSON อีกชั้น จึงต้องแกะสองรอบ */
export async function fetchKiosk(cfg) {
  const res = await fetch(kioskApiUrl(cfg), {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`เรียก Kiosk ไม่สำเร็จ (HTTP ${res.status})`);

  const body = await res.json().catch(() => null);
  if (!body) throw new Error('Kiosk ตอบกลับมาไม่ใช่ JSON — URL อาจหมดอายุหรือถูกปิดไปแล้ว');

  let data = body.data ?? body;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      /* ถ้าแกะไม่ได้ ก็ใช้ของเดิม */
    }
  }
  return { raw: body, data };
}

/**
 * ไล่เก็บค่าตัวเลขทุกตัวใน JSON พร้อมเส้นทางของมัน
 * ใช้ตอน probe เพื่อดูว่า Kiosk ให้อะไรมาบ้างจริง ๆ โดยไม่ต้องเดาชื่อฟิลด์
 */
export function flattenNumbers(obj, prefix = '', out = {}, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return out;

  if (Array.isArray(obj)) {
    // อาเรย์ยาว ๆ มักเป็นกราฟ เก็บแค่ตัวท้ายสุดพอ (ค่าล่าสุด)
    if (obj.length && obj.every((v) => typeof v === 'number' || v === null)) {
      const nums = obj.filter((v) => typeof v === 'number');
      if (nums.length) out[`${prefix}[ล่าสุด]`] = nums[nums.length - 1];
      out[`${prefix}[จำนวน]`] = obj.length;
      return out;
    }
    obj.slice(0, 3).forEach((v, i) => flattenNumbers(v, `${prefix}[${i}]`, out, depth + 1));
    return out;
  }

  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      flattenNumbers(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
    return out;
  }

  const n = typeof obj === 'string' ? Number(obj) : obj;
  if (typeof n === 'number' && Number.isFinite(n)) out[prefix] = n;
  return out;
}

/**
 * คำที่บ่งบอกว่าเป็นข้อมูลฝั่งไหน — ใช้เดาแบบมีหลักการตอน probe
 * ไม่ได้ใช้ตัดสินใจจริงในการเตือน การเตือนจะใช้ค่าที่ตั้งไว้ใน KIOSK_FIELD_MAP เท่านั้น
 */
const HINTS = {
  pv: [/pv/i, /solar/i, /realtimepower/i, /activepower/i, /generat/i],
  grid: [/grid/i, /buy/i, /purchas/i, /import/i, /meter/i],
  load: [/load/i, /consum/i, /use.?power/i, /selfuse/i],
};

/** จัดกลุ่มฟิลด์ที่เจอ ว่าน่าจะเป็นฝั่งผลิต / ซื้อไฟ / โหลด */
export function guessFields(flat) {
  const guess = { pv: [], grid: [], load: [], other: [] };
  for (const key of Object.keys(flat)) {
    let placed = false;
    for (const [kind, patterns] of Object.entries(HINTS)) {
      if (patterns.some((re) => re.test(key))) {
        guess[kind].push(key);
        placed = true;
        break;
      }
    }
    if (!placed) guess.other.push(key);
  }
  return guess;
}

/**
 * อ่านค่ากำลังไฟจาก Kiosk ตามการจับคู่ฟิลด์ที่ตั้งไว้
 * ตั้งได้ที่ KIOSK_FIELD_MAP เช่น {"pv":"realKpi.realTimePower","grid":"...","load":"..."}
 *
 * ถ้าไม่ได้ตั้ง หรือไม่มีฟิลด์ฝั่งซื้อไฟ/โหลด จะคืน gridImportKw = null
 * ซึ่งชั้นบนจะถือว่า "วัดไม่ได้" และไม่เตือนมั่ว — ตั้งใจให้เป็นแบบนั้น
 */
export async function readNowFromKiosk(cfg) {
  const { data } = await fetchKiosk(cfg);
  const flat = flattenNumbers(data);
  const map = cfg.kioskFieldMap || {};

  const pick = (name) => (map[name] && flat[map[name]] !== undefined ? flat[map[name]] : null);

  const pvKw = pick('pv');
  const gridRaw = pick('grid');
  const loadRaw = pick('load');

  // ถ้ามี pv กับ load ก็คำนวณ grid ได้เอง และกลับกัน
  let gridImportKw = gridRaw !== null ? cfg.meterSign * gridRaw : null;
  let loadKw = loadRaw;
  if (gridImportKw === null && loadKw !== null && pvKw !== null) gridImportKw = loadKw - pvKw;
  if (loadKw === null && gridImportKw !== null && pvKw !== null) loadKw = pvKw + gridImportKw;

  return {
    source: 'kiosk',
    stationCode: 'kiosk',
    pvKw: pvKw ?? 0,
    gridImportKw,
    loadKw,
    batteryKw: 0,
    dayPvKwh: null,
    meterFound: gridImportKw !== null,
    availableFields: Object.keys(flat).length,
  };
}
