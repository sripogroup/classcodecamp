/**
 * ค่าตั้งต้นทั้งหมดของระบบ
 *
 * ทุกค่าตรงนี้ override ได้จาก Cloudflare (Settings > Variables) โดยไม่ต้องแก้โค้ด
 * ชื่อตัวแปรบน Cloudflare = ชื่อ KEY ตัวใหญ่ในวงเล็บ เช่น WARN_IMPORT_KW
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined || v === null || v === '' ? d : String(v) === 'true' || v === '1');
const str = (v, d) => (v === undefined || v === null || v === '' ? d : String(v));

export function loadConfig(env = {}) {
  const cfg = {
    // ---------- การเชื่อมต่อ FusionSolar ----------
    // โซนเซิร์ฟเวอร์: ไทยใช้ intl (sg5) เป็นหลัก / ยุโรปใช้ eu5
    fusionBase: str(env.FUSION_BASE, 'https://intl.fusionsolar.huawei.com'),
    fusionUser: str(env.FUSION_USER, ''),
    fusionPass: str(env.FUSION_SYSTEM_CODE, ''),
    stationCode: str(env.FUSION_STATION_CODE, ''), // ว่างไว้ = ดึงโรงแรกอัตโนมัติ

    // ทิศทางของมิเตอร์ (Smart Power Sensor)
    // 1  = ค่าบวกคือ "ซื้อไฟจากการไฟฟ้า"
    // -1 = ค่าบวกคือ "ขายไฟออก"  (ถ้าตอนกลางคืนขึ้นเป็นลบ ให้ใช้ -1)
    meterSign: num(env.METER_SIGN, 1),
    includeBattery: bool(env.INCLUDE_BATTERY, true),

    // ---------- เกณฑ์แจ้งเตือน (หน่วย kW ของ "ไฟที่ดึงจากการไฟฟ้า") ----------
    warnKw: num(env.WARN_IMPORT_KW, 15), // 🟡 เริ่มเฝ้าระวัง
    critKw: num(env.CRIT_IMPORT_KW, 30), // 🔴 ต้องลดโหลดทันที
    hysteresisKw: num(env.HYSTERESIS_KW, 5), // กันเด้งไปมาแถวเส้นเกณฑ์

    // ต้องเกินเกณฑ์ติดกันกี่รอบถึงจะเตือน (1 รอบ = 5 นาที)
    sustainPolls: num(env.SUSTAIN_POLLS, 2), // = เกิน 10 นาทีจริงถึงเตือน (เมฆบังแป๊บเดียวไม่เตือน)
    recoverPolls: num(env.RECOVER_POLLS, 3), // ต้องดีขึ้นติดกัน 15 นาทีถึงบอกว่ากลับสู่ปกติ

    // ---------- กันสแปม ----------
    repeatMin: num(env.REPEAT_MIN, 30), // ยังแดงอยู่ ย้ำซ้ำทุกกี่นาที
    escalateMin: num(env.ESCALATE_MIN, 20), // แดงเกินกี่นาทีโดยไม่มีใครกด /ack ให้ตามหัวหน้า
    ackSuppressMin: num(env.ACK_SUPPRESS_MIN, 60), // กด /ack แล้วเงียบให้กี่นาที

    // ---------- เวลาทำงาน (เวลาไทย) ----------
    workStartHour: num(env.WORK_START_HOUR, 8),
    workEndHour: num(env.WORK_END_HOUR, 17),
    workDays: str(env.WORK_DAYS, '1,2,3,4,5,6') // 0=อาทิตย์
      .split(',')
      .map((d) => Number(d.trim()))
      .filter(Number.isFinite),
    alertYellowOutsideWork: bool(env.ALERT_YELLOW_OUTSIDE_WORK, false),

    // ---------- เฝ้าระวังตอนกลางคืน (อุปกรณ์เปิดค้าง) ----------
    nightWatch: bool(env.NIGHT_WATCH, true),
    nightStartHour: num(env.NIGHT_START_HOUR, 20),
    nightEndHour: num(env.NIGHT_END_HOUR, 5),
    nightIdleKw: num(env.NIGHT_IDLE_KW, 8), // กลางคืนไม่ควรเกินเท่านี้

    // ---------- เฝ้าระวังอินเวอร์เตอร์ ----------
    inverterWatch: bool(env.INVERTER_WATCH, true),
    systemKwp: num(env.SYSTEM_KWP, 100), // ขนาดติดตั้งรวม (kWp) ใช้เทียบว่าผลิตต่ำผิดปกติไหม
    sunStartHour: num(env.SUN_START_HOUR, 10),
    sunEndHour: num(env.SUN_END_HOUR, 15),

    // ---------- ค่าไฟ (ไว้คำนวณเงินที่เสียไป) ----------
    tariffOnPeak: num(env.TARIFF_ON_PEAK, 4.5), // บาท/kWh
    tariffOffPeak: num(env.TARIFF_OFF_PEAK, 2.8),
    useTou: bool(env.USE_TOU, false), // ถ้าใช้อัตรา TOU ให้เปิด
    demandChargeBahtPerKw: num(env.DEMAND_CHARGE, 0), // ค่าความต้องการพลังไฟฟ้า บาท/kW ถ้ามี
    peakDemandTargetKw: num(env.PEAK_DEMAND_TARGET_KW, 0), // เพดาน demand ที่ไม่อยากให้เกิน (0 = ปิด)

    // ---------- รายการสิ่งที่ให้พนักงานไปปิด (เรียงจากปิดง่าย/คุ้มสุดก่อน) ----------
    // ตั้งเป็น JSON บน Cloudflare ได้: LOAD_SHED_LIST
    // [{"name":"แอร์ออฟฟิศชั้น 2","kw":12,"owner":"ธุรการ"}, ...]
    loadShed: parseJson(env.LOAD_SHED_LIST, [
      { name: 'แอร์ออฟฟิศชั้น 2', kw: 12, owner: 'ธุรการ' },
      { name: 'แอร์ห้องประชุม (ถ้าไม่มีประชุม)', kw: 6, owner: 'ธุรการ' },
      { name: 'ปั๊มน้ำสำรอง', kw: 7, owner: 'ช่างซ่อมบำรุง' },
      { name: 'เลื่อนเดินคอมเพรสเซอร์ตัวที่ 2', kw: 15, owner: 'หัวหน้ากะ' },
    ]),

    // ---------- ช่องทางแจ้งเตือน ----------
    telegramToken: str(env.TELEGRAM_BOT_TOKEN, ''),
    telegramChatId: str(env.TELEGRAM_CHAT_ID, ''), // กลุ่มพนักงาน
    telegramBossChatId: str(env.TELEGRAM_BOSS_CHAT_ID, ''), // หัวหน้า (ใช้ตอน escalate) ว่างได้
    telegramWebhookSecret: str(env.TELEGRAM_WEBHOOK_SECRET, ''),

    resendApiKey: str(env.RESEND_API_KEY, ''),
    brevoApiKey: str(env.BREVO_API_KEY, ''),
    mailFrom: str(env.MAIL_FROM, ''), // เช่น solar@yourdomain.com
    mailTo: str(env.MAIL_TO, '') // คั่นด้วย , ได้
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    dashboardToken: str(env.DASHBOARD_TOKEN, ''), // ว่าง = เปิดให้ดูได้เลย
    siteName: str(env.SITE_NAME, 'โรงงาน'),
  };

  return cfg;
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
