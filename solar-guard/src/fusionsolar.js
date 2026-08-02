/**
 * ตัวดึงข้อมูลจาก Huawei FusionSolar (Northbound / thirdData API)
 *
 * ข้อควรรู้:
 * - ต้องขอบัญชี "Northbound API" จากดีลเลอร์/ผู้ติดตั้ง (คนละตัวกับ user ที่ล็อกอินแอพ)
 * - token (XSRF-TOKEN) อายุ ~30 นาที -> เก็บใน KV ใช้ซ้ำ ไม่งั้นจะโดนบล็อกเพราะล็อกอินถี่
 * - API จำกัดความถี่ (failCode 407) -> ห้ามยิงถี่กว่า 5 นาที/ครั้ง
 */

const DEV_TYPE = {
  STRING_INVERTER: 1,
  RESIDENTIAL_INVERTER: 38,
  GRID_METER: 17,
  POWER_SENSOR: 47,
  BATTERY: 39,
  ESS: 41,
};

const INVERTER_TYPES = [DEV_TYPE.STRING_INVERTER, DEV_TYPE.RESIDENTIAL_INVERTER];
const METER_TYPES = [DEV_TYPE.GRID_METER, DEV_TYPE.POWER_SENSOR];
const BATTERY_TYPES = [DEV_TYPE.BATTERY, DEV_TYPE.ESS];

const TOKEN_KEY = 'fusion:token';
const DEVICES_KEY = 'fusion:devices';
const TOKEN_TTL_S = 25 * 60; // เผื่อไว้ก่อนหมดอายุจริง 30 นาที
const DEVICES_TTL_S = 12 * 60 * 60;

export class FusionSolarError extends Error {
  constructor(message, failCode) {
    super(message);
    this.name = 'FusionSolarError';
    this.failCode = failCode;
  }
}

export class FusionSolar {
  constructor(cfg, kv) {
    this.cfg = cfg;
    this.kv = kv;
    this.base = cfg.fusionBase.replace(/\/+$/, '');
    this.token = null;
  }

  async login() {
    const res = await fetch(`${this.base}/thirdData/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: this.cfg.fusionUser, systemCode: this.cfg.fusionPass }),
    });

    const token = res.headers.get('xsrf-token') || pickCookie(res, 'XSRF-TOKEN');
    const body = await safeJson(res);

    if (!token) {
      throw new FusionSolarError(
        `ล็อกอิน FusionSolar ไม่สำเร็จ (${body?.failCode ?? res.status}) — ตรวจ FUSION_USER / FUSION_SYSTEM_CODE / FUSION_BASE`,
        body?.failCode,
      );
    }

    this.token = token;
    await this.kv.put(TOKEN_KEY, token, { expirationTtl: TOKEN_TTL_S });
    return token;
  }

  async ensureToken() {
    if (this.token) return this.token;
    this.token = await this.kv.get(TOKEN_KEY);
    if (!this.token) await this.login();
    return this.token;
  }

  /** เรียก API พร้อม re-login อัตโนมัติเมื่อ token หมดอายุ */
  async call(path, payload, retry = true) {
    const token = await this.ensureToken();
    const res = await fetch(`${this.base}/thirdData/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'XSRF-TOKEN': token },
      body: JSON.stringify(payload),
    });

    const body = await safeJson(res);

    // 305/401 = token หมดอายุ/ยังไม่ล็อกอิน
    if (body && (body.failCode === 305 || body.failCode === 401) && retry) {
      await this.kv.delete(TOKEN_KEY);
      this.token = null;
      await this.login();
      return this.call(path, payload, false);
    }

    // 407 = ยิงถี่เกินไป — ปล่อยให้ชั้นบนใช้ค่าเดิมไปก่อน อย่ายิงซ้ำ
    if (body && body.failCode === 407) {
      throw new FusionSolarError('FusionSolar ปฏิเสธเพราะเรียกถี่เกินไป (407) — รอรอบถัดไป', 407);
    }

    if (!body || body.success === false) {
      throw new FusionSolarError(`FusionSolar ${path} ล้มเหลว (failCode=${body?.failCode ?? res.status})`, body?.failCode);
    }

    return body.data;
  }

  async resolveStationCode() {
    if (this.cfg.stationCode) return this.cfg.stationCode;

    // API ใหม่ก่อน แล้วค่อยถอยไปตัวเก่า
    try {
      const data = await this.call('stations', { pageNo: 1, pageSize: 10 });
      const code = data?.list?.[0]?.plantCode;
      if (code) return code;
    } catch (_) {
      /* ลองตัวเก่าต่อ */
    }

    const list = await this.call('getStationList', {});
    const code = Array.isArray(list) ? list[0]?.stationCode : null;
    if (!code) throw new FusionSolarError('ไม่พบโรงไฟฟ้าในบัญชีนี้ — ตั้ง FUSION_STATION_CODE เอง');
    return code;
  }

  /** รายชื่ออุปกรณ์ (cache ไว้ครึ่งวัน อุปกรณ์ไม่ได้เปลี่ยนบ่อย) */
  async getDevices(stationCode) {
    const cached = await this.kv.get(DEVICES_KEY, 'json');
    if (cached && cached.stationCode === stationCode) return cached.devices;

    const devices = (await this.call('getDevList', { stationCodes: stationCode })) || [];
    await this.kv.put(DEVICES_KEY, JSON.stringify({ stationCode, devices }), { expirationTtl: DEVICES_TTL_S });
    return devices;
  }

  /**
   * อ่านค่ากำลังไฟ ณ ปัจจุบัน
   * คืน { pvKw, gridImportKw, loadKw, batteryKw, meterFound, dayPvKwh, stationCode }
   * gridImportKw บวก = ซื้อไฟจากการไฟฟ้า / ลบ = ขายไฟออก
   */
  async readNow() {
    const stationCode = await this.resolveStationCode();
    const devices = await this.getDevices(stationCode);

    const byType = new Map();
    for (const d of devices) {
      const t = Number(d.devTypeId);
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(String(d.id ?? d.devId));
    }

    const sumFor = async (types, fields) => {
      let total = 0;
      let found = false;
      for (const t of types) {
        const ids = byType.get(t);
        if (!ids || !ids.length) continue;
        const rows = await this.call('getDevRealKpi', { devIds: ids.join(','), devTypeId: t });
        for (const row of rows || []) {
          const map = row.dataItemMap || {};
          for (const f of fields) {
            if (map[f] !== undefined && map[f] !== null && map[f] !== 'N/A') {
              total += Number(map[f]) || 0;
              found = true;
              break;
            }
          }
        }
      }
      return { total, found };
    };

    const pv = await sumFor(INVERTER_TYPES, ['active_power', 'mppt_power']);
    const meter = await sumFor(METER_TYPES, ['active_power']);
    const battery = this.cfg.includeBattery
      ? await sumFor(BATTERY_TYPES, ['ch_discharge_power', 'charge_discharge_power'])
      : { total: 0, found: false };

    // มิเตอร์: ปรับทิศทางตามที่ตั้งไว้ ให้ "บวก = ซื้อไฟเข้า"
    const gridImportKw = meter.found ? this.cfg.meterSign * meter.total : null;

    // แบตเตอรี่: บวก = คายประจุ (ช่วยจ่ายโหลด)
    const batteryKw = battery.found ? battery.total : 0;

    const pvKw = pv.total;
    const loadKw = gridImportKw === null ? null : pvKw + gridImportKw + batteryKw;

    let dayPvKwh = null;
    try {
      const kpi = await this.call('getStationRealKpi', { stationCodes: stationCode });
      dayPvKwh = Number(kpi?.[0]?.dataItemMap?.day_power) || null;
    } catch (_) {
      /* ไม่ใช่ค่าสำคัญ ข้ามได้ */
    }

    return {
      stationCode,
      pvKw,
      gridImportKw,
      loadKw,
      batteryKw,
      dayPvKwh,
      meterFound: meter.found,
      inverterCount: (byType.get(1)?.length || 0) + (byType.get(38)?.length || 0),
    };
  }
}

function pickCookie(res, name) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const c of all) {
    const m = new RegExp(`${name}=([^;]+)`).exec(c || '');
    if (m) return m[1];
  }
  return null;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
