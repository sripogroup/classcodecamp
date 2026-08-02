/**
 * ตัวสั่งงานอุปกรณ์จริง
 *
 * ⚠️ ข้อจำกัดที่ต้องรู้ก่อน:
 * Cloudflare Workers อยู่บนอินเทอร์เน็ต **เรียกเข้า IP ในวง LAN ของโรงงานไม่ได้**
 * เพราะฉะนั้นการสั่งรีเลย์ตรง ๆ ที่ 192.168.x.x จะไม่ทำงาน มีทางเลือก 2 แบบ:
 *
 *   1. โหมด "pull" (แนะนำ ฟรี ไม่ต้องเปิดพอร์ต):
 *      ตัวควบคุมในโรงงาน (ESP32 / Shelly script) เป็นฝ่ายถาม Worker เองทุก 20-30 วินาที
 *      ว่าโซนไหนควรเปิด/ปิด แล้วสั่งรีเลย์เอง — Worker ไม่ต้องเข้าถึง LAN เลย
 *      ตั้ง driver ของโซนเป็น "pull" แล้วให้ตัวควบคุมอ่าน GET /api/zones
 *
 *   2. โหมด "push": ใช้กับอุปกรณ์ที่มี Cloud API ให้เรียกจากอินเทอร์เน็ตได้
 *      - shelly  : Shelly Cloud API (รีเลย์ตัดวงจร)
 *      - sensibo : Sensibo (สั่งแอร์ผ่าน IR ปิด หรือขยับอุณหภูมิขึ้น — นุ่มนวลกว่าตัดไฟ)
 *      - webhook : ยิง URL อะไรก็ได้ที่คุณเตรียมไว้เอง
 */

/**
 * สั่งเปิด/ปิดโซนหนึ่ง
 * @param zone   ข้อมูลโซนจาก ZONES
 * @param on     true = ให้ทำงานปกติ, false = ให้หยุด
 * @param dryRun ถ้าจริง จะไม่ยิงคำสั่งจริง แค่บอกว่าจะทำอะไร
 */
export async function applyZone(zone, on, dryRun = false) {
  const driver = zone.driver || 'pull';

  if (dryRun) return { ok: true, driver, dryRun: true, detail: `(ซ้อม) จะสั่ง ${zone.name} เป็น ${on ? 'เปิด' : 'ปิด'}` };

  try {
    switch (driver) {
      case 'pull':
        // ไม่ต้องทำอะไร ตัวควบคุมในโรงงานจะมาอ่านสถานะเอง
        return { ok: true, driver, detail: 'รอตัวควบคุมในโรงงานมาอ่านสถานะ' };
      case 'shelly':
        return await shelly(zone, on);
      case 'sensibo':
        return await sensibo(zone, on);
      case 'webhook':
        return await webhook(zone, on);
      default:
        return { ok: false, driver, error: `ไม่รู้จัก driver "${driver}"` };
    }
  } catch (err) {
    return { ok: false, driver, error: String(err?.message || err) };
  }
}

/**
 * Shelly Cloud API — รีเลย์ตัดวงจรไฟ
 * ต้องมีใน zone: { server: "shelly-53-eu.shelly.cloud", deviceId: "xxxx", authKey: "xxxx", channel: 0 }
 */
async function shelly(zone, on) {
  const body = new URLSearchParams({
    id: zone.deviceId,
    auth_key: zone.authKey,
    channel: String(zone.channel ?? 0),
    turn: on ? 'on' : 'off',
  });
  const res = await fetch(`https://${zone.server}/device/relay/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data?.isok !== false, driver: 'shelly', detail: data };
}

/**
 * Sensibo — สั่งแอร์ผ่าน IR
 * โหมด "setpoint" จะขยับอุณหภูมิขึ้นแทนการปิด (คนแทบไม่รู้สึก แต่ลดโหลดได้ 10-20%)
 * ต้องมีใน zone: { apiKey, podId, mode: "off" | "setpoint", normalTemp: 25, shedTemp: 27 }
 */
async function sensibo(zone, on) {
  const base = `https://home.sensibo.com/api/v2/pods/${zone.podId}/acStates`;

  if ((zone.mode || 'off') === 'setpoint') {
    const value = on ? (zone.normalTemp ?? 25) : (zone.shedTemp ?? 27);
    const res = await fetch(`${base}/targetTemperature?apiKey=${zone.apiKey}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newValue: value }),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, driver: 'sensibo', detail: `ตั้งอุณหภูมิเป็น ${value}°C`, data };
  }

  const res = await fetch(`${base}/on?apiKey=${zone.apiKey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newValue: on }),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, driver: 'sensibo', detail: on ? 'สั่งเปิดแอร์' : 'สั่งปิดแอร์', data };
}

/**
 * Webhook ทั่วไป — ใช้กับอะไรก็ได้ที่คุณต่อเองไว้
 * ต้องมีใน zone: { onUrl, offUrl, method?: "GET"|"POST", headers?: {} }
 */
async function webhook(zone, on) {
  const url = on ? zone.onUrl : zone.offUrl;
  if (!url) return { ok: false, driver: 'webhook', error: 'ไม่ได้ตั้ง onUrl / offUrl' };
  const res = await fetch(url, { method: zone.method || 'GET', headers: zone.headers || {} });
  return { ok: res.ok, driver: 'webhook', detail: `${zone.method || 'GET'} ${url} -> ${res.status}` };
}
