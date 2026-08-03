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

    // แหล่งข้อมูลทางเลือก: Kiosk View (ไม่ต้องใช้บัญชี Northbound API)
    // kioskKey = ค่า kk= ที่อยู่ท้าย URL ของ Kiosk
    // ใช้ได้ต่อเมื่อ Kiosk มีข้อมูลฝั่งใช้ไฟด้วย — เช็คด้วย /api/probe-kiosk ก่อน
    // api   = ดึงจาก Northbound API (ต้องมีบัญชีจากดีลเลอร์)
    // kiosk = ดึงจาก Kiosk View (ยืนยันแล้วว่าไม่มีข้อมูลฝั่งใช้ไฟ ใช้ไม่ได้)
    // push  = ตัวอ่านในโรงงานส่งค่าเข้ามาเอง ทาง POST /api/ingest (ไม่ต้องพึ่งคลาวด์ Huawei เลย)
    // local = สมองอยู่บนเครื่องในโรงงาน คลาวด์เป็นแค่ยามคอยฟังสัญญาณ "ยังอยู่ดี"
    dataSource: ['api', 'kiosk', 'push', 'local'].includes(str(env.DATA_SOURCE, 'api')) ? str(env.DATA_SOURCE, 'api') : 'api',
    localDownMin: num(env.LOCAL_DOWN_MIN, 25), // เงียบเกินกี่นาทีถือว่าเครื่องในโรงงานตาย
    ingestToken: str(env.INGEST_TOKEN, ''), // รหัสลับของตัวอ่านในโรงงาน
    kioskKey: str(env.KIOSK_KEY, ''),
    kioskBase: str(env.KIOSK_BASE, ''),
    kioskFieldMap: parseJsonObject(env.KIOSK_FIELD_MAP, {}),

    // ทิศทางของมิเตอร์ (Smart Power Sensor)
    // 1  = ค่าบวกคือ "ซื้อไฟจากการไฟฟ้า"
    // -1 = ค่าบวกคือ "ขายไฟออก"  (ถ้าตอนกลางคืนขึ้นเป็นลบ ให้ใช้ -1)
    meterSign: num(env.METER_SIGN, 1),
    includeBattery: bool(env.INCLUDE_BATTERY, true),

    // ---------- เส้นตายของการไฟฟ้า (สำคัญที่สุดในไฟล์นี้) ----------
    // ผู้ใช้ไฟประเภทที่ 2 ถ้าเดือนไหนมีค่าเฉลี่ย 15 นาทีสูงสุด >= 30 kW แม้แค่ครั้งเดียว
    // จะถูกย้ายไปประเภทที่ 3 และต้องต่ำกว่า 30 kW ติดต่อกัน 12 เดือนถึงจะกลับมาได้
    demandLimitKw: num(env.DEMAND_LIMIT_KW, 30), // ❌ ห้ามแตะเด็ดขาด
    demandTargetKw: num(env.DEMAND_TARGET_KW, 27), // 🎯 เป้าที่ระบบพยายามคุมไว้ (เผื่อ margin จากเส้นตาย)
    demandActionKw: num(env.DEMAND_ACTION_KW, 24), // 🤖 ถึงตรงนี้เริ่มตัดโหลดอัตโนมัติ
    demandRestoreKw: num(env.DEMAND_RESTORE_KW, 18), // ✅ ลงมาต่ำกว่านี้ถึงจะเปิดกลับ

    // ---------- เพดาน "ค่า ณ ขณะนั้น" ----------
    // กฎเขียนว่าคิดจากค่าเฉลี่ย 15 นาที แต่เจ้าของโรงงานโดนปรับมาแล้ว 2 ครั้ง
    // จากการที่ไฟหลวง "ณ ขณะนั้น" เกิน 30 kW — ไม่ใช่ค่าเฉลี่ย
    // ตัวนี้จึงเป็นเส้นที่เตือนทันทีตั้งแต่ตัวอย่างแรกที่เกิน ไม่รอ sustainPolls
    // ไม่รอหน้าต่าง 15 นาที ไม่รอค่าเฉลี่ยใด ๆ ทั้งสิ้น
    instantTripKw: num(env.INSTANT_TRIP_KW, 28),

    // ---------- เกณฑ์แจ้งเตือนคน (หน่วย kW ของ "ไฟที่ดึงจากการไฟฟ้า") ----------
    warnKw: num(env.WARN_IMPORT_KW, 20), // 🟡 เริ่มเฝ้าระวัง
    critKw: num(env.CRIT_IMPORT_KW, 26), // 🔴 ต้องลดโหลดทันที ก่อนจะถึงเส้นตาย
    hysteresisKw: num(env.HYSTERESIS_KW, 3), // กันเด้งไปมาแถวเส้นเกณฑ์

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
    // สองตัวนี้เป็นราคา "รวม Ft และ VAT แล้ว" ใช้ในข้อความเตือนเพื่อบอกคร่าว ๆ ว่า
    // ตอนนี้เสียเงินชั่วโมงละเท่าไหร่ — ไม่ได้ใช้คิดบิล (บิลใช้ชุดข้างล่าง)
    tariffOnPeak: num(env.TARIFF_ON_PEAK, 4.5), // บาท/kWh
    tariffOffPeak: num(env.TARIFF_OFF_PEAK, 2.8),
    useTou: bool(env.USE_TOU, false), // ถ้าใช้อัตรา TOU ให้เปิด

    // ---------- โครงสร้างบิล PEA (ใช้คิดค่าไฟจริงใน src/bill.js) ----------
    // ค่าเริ่มต้นทั้งหมดถอดมาจากบิลจริงเลขที่ 871006112454 รอบ 07/2569
    // อัตรา TOU แรงดัน 22-33 kV — ถ้าการไฟฟ้าปรับอัตรา ให้แก้ที่ตัวแปรบน Cloudflare
    tariffBaseOnPeak: num(env.TARIFF_BASE_ON_PEAK, 4.1839), // บาท/kWh ก่อน Ft และ VAT
    tariffBaseOffPeak: num(env.TARIFF_BASE_OFF_PEAK, 2.6037),
    // ค่าความต้องการพลังไฟฟ้า คิดจากค่าเฉลี่ย 15 นาทีสูงสุดของเดือน **เฉพาะช่วง on-peak**
    // ตัวนี้คือเหตุผลทางการเงินทั้งหมดของระบบนี้ — กดพีคลง 1 kW = ประหยัดเท่านี้ต่อเดือน
    demandChargePerKw: num(env.DEMAND_CHARGE_PER_KW, 132.93),
    serviceCharge: num(env.SERVICE_CHARGE, 312.24), // ค่าบริการรายเดือน (คงที่)
    ftPerKwh: num(env.FT_PER_KWH, 0.1623), // Ft งวด ก.ค.69-ธ.ค.69 — ต้องอัปเดตทุก 4 เดือน
    vatPct: num(env.VAT_PCT, 7),
    // ขาดข้อมูลเกินกี่นาทีถือว่าเดาไม่ได้ ให้ข้ามช่วงนั้นแทนที่จะเดามั่ว
    billMaxGapMin: num(env.BILL_MAX_GAP_MIN, 15),
    // หน้าต่าง 15 นาทีต้องมีข้อมูลอย่างน้อยกี่นาทีถึงจะเอาไปคิดค่า demand ได้
    billMinWindowMin: num(env.BILL_MIN_WINDOW_MIN, 5),
    // ส่วนต่างค่าไฟต่อเดือนถ้าโดนย้ายไปประเภทที่ 3 (ใช้บอกว่า "พลาดครั้งเดียวเสียเท่าไหร่")
    tierPenaltyPerMonth: num(env.TIER_PENALTY_PER_MONTH, 3000),

    // ---------- ช่วงเวลาที่กราฟแสดง ----------
    // ตัดกลางดึกทิ้ง เพราะร้านปิดแล้วและไม่มีอะไรให้ดู เหลือแต่เส้นแบน ๆ
    // ที่กินพื้นที่ครึ่งจอ เริ่มตอนแดดเริ่มออกจนถึงเวลาปิดร้านจริง
    // ใช้ทศนิยมได้ เช่น 5.5 = 05:30
    chartStartHour: num(env.CHART_START_HOUR, 5.5),
    chartEndHour: num(env.CHART_END_HOUR, 21),

    // ---------- ประวัติที่เก็บไว้วาดกราฟ ----------
    // เก็บช่วงละกี่วินาที (ตัวอ่านยิงมาทุก 30 วิ ถ้าเก็บหมดจะได้ประวัติแค่ 2-3 ชั่วโมง)
    sampleGapSec: num(env.SAMPLE_GAP_SEC, 120),
    sampleMax: num(env.SAMPLE_MAX, 800), // 800 จุด x 2 นาที = 26 ชั่วโมง

    // ---------- เฝ้าระวังเข้มช่วงเย็น (ช่วงที่แพงที่สุดของวัน) ----------
    // ตั้งแต่เวลานี้จนจบ on-peak (22:00) ระบบจะลดเกณฑ์เตือนลง เพื่อให้รู้ตัวเร็วขึ้น
    // เพราะเป็นช่วงที่แดดตกแต่โหลดยังอยู่ และเป็นช่วงที่คิดค่าความต้องการพลังไฟฟ้า
    eveningWatch: bool(env.EVENING_WATCH, true),
    eveningWatchHour: num(env.EVENING_WATCH_HOUR, 15),
    eveningWatchTightenKw: num(env.EVENING_WATCH_TIGHTEN_KW, 3), // ลดเกณฑ์เตือนลงกี่ kW

    // ---------- เฝ้าระวัง: ซื้อไฟมากกว่าที่โซลาร์ผลิตได้ ----------
    // เตือนเฉพาะช่วงแดดแรง (SUN_START_HOUR ถึง SUN_END_HOUR) เท่านั้น
    // ถ้าเปิดให้เตือนทั้งวันจะเตือนทุกคืน เพราะกลางคืนโซลาร์ผลิต 0 อยู่แล้ว
    pvBelowGridWatch: bool(env.PV_BELOW_GRID_WATCH, true),
    // ไฟหลวงต้องมากกว่าโซลาร์เกินกี่ kW ถึงจะนับ (กันเด้งตอนสองค่าไล่เลี่ยกัน)
    pvBelowGridMarginKw: num(env.PV_BELOW_GRID_MARGIN_KW, 1),
    pvBelowGridRepeatMin: num(env.PV_BELOW_GRID_REPEAT_MIN, 120), // ย้ำซ้ำห่างกันกี่นาที

    // ---------- ตัดโหลดอัตโนมัติ ----------
    // off    = ไม่ทำอะไร แค่เตือนคน (ค่าเริ่มต้น — ปลอดภัยที่สุด)
    // dryrun = คิดครบทุกอย่างและรายงานว่าจะสั่งอะไร แต่ไม่สั่งจริง (ใช้ทดสอบ 1-2 สัปดาห์)
    // on     = สั่งจริง
    autoshedMode: ['off', 'dryrun', 'on'].includes(str(env.AUTOSHED_MODE, 'off')) ? str(env.AUTOSHED_MODE, 'off') : 'off',
    shedMarginKw: num(env.SHED_MARGIN_KW, 2), // ตัดเผื่อไว้อีกนิด กันตัดไม่พอ
    autoshedMinOffMin: num(env.AUTOSHED_MIN_OFF_MIN, 10), // ปิดแล้วต้องปิดค้างอย่างน้อยกี่นาที (กันคอมเพรสเซอร์พัง)
    autoshedMinOnMin: num(env.AUTOSHED_MIN_ON_MIN, 15), // เปิดกลับแล้วต้องเปิดค้างอย่างน้อยกี่นาที
    autoshedMaxOffMin: num(env.AUTOSHED_MAX_OFF_MIN, 30), // ปิดต่อเนื่องนานสุด แล้วหมุนเวียนไปโซนอื่น
    autoshedMaxZones: num(env.AUTOSHED_MAX_ZONES, 3), // ปิดพร้อมกันได้มากสุดกี่โซน
    autoshedRestoreGapMin: num(env.AUTOSHED_RESTORE_GAP_MIN, 3), // เปิดกลับห่างกันกี่นาที (กันกระชากพร้อมกัน)

    // ---------- งานประจำที่ต้องทำทุกวัน (ตัวกันเคส "คนที่รับผิดชอบไม่อยู่") ----------
    // at           เวลาที่ต้องทำ (เวลาไทย)
    // graceMin     ให้เวลากี่นาทีก่อนเริ่มตรวจ
    // expectDropKw คาดว่า "โหลดรวม" จะลดลงอย่างน้อยกี่ kW ถ้ามีคนทำจริง
    // repeatMin    ย้ำทุกกี่นาทีถ้ายังไม่มีใครทำ
    // giveUpMin    เลยเวลามากี่นาทีแล้วหยุดย้ำ (แต่จะสรุปให้รู้ว่าวันนี้ไม่มีใครทำ)
    dailyTasks: parseJson(env.DAILY_TASKS, [
      {
        id: 'ac_1500',
        name: 'ปิดแอร์ 3 ตัว',
        at: '15:00',
        graceMin: 10,
        expectDropKw: 8,
        repeatMin: 10,
        giveUpMin: 90,
        days: [1, 2, 3, 4, 5, 6],
        owner: 'ฝ่ายธุรการ',
      },
    ]),

    // โซนที่ระบบสั่งได้ ตั้งเป็น JSON ที่ตัวแปร ZONES — ดูตัวอย่างใน docs/AUTOSHED.md
    // priority น้อย = ยอมให้ปิดก่อน, protected = ห้ามแตะเด็ดขาด
    zones: parseJson(env.ZONES, []),

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

    // ---------- เวลาที่ยอมให้รบกวนกลุ่มพนักงาน ----------
    // นอกช่วงนี้ ข้อความจะไปหาหัวหน้าคนเดียว ไม่เข้ากลุ่ม
    //
    // พ่อเต้ยสั่งเมื่อ 3 ส.ค. 2569: หลังสามทุ่ม... หลังหนึ่งทุ่มไม่ต้องกวนพนักงาน
    // เรื่องไฟยังต้องมีคนรู้ (พีคที่เกิดสองทุ่มก็แพงเท่าตอนบ่าย เพราะ on-peak
    // ยาวถึงสี่ทุ่ม) แต่คนที่ต้องรู้คือคนที่ตัดสินใจได้ ไม่ใช่ทั้งกลุ่ม
    staffHourStart: num(env.STAFF_HOUR_START, 8),
    staffHourEnd: num(env.STAFF_HOUR_END, 19),

    // ---------- LINE ----------
    // ที่โรงงานใช้ LINE อยู่แล้วและมีบอทผูกกับพนักงานไว้แล้ว จึงใช้ช่องทางนี้เป็นหลัก
    // lineTo = userId หรือ groupId ใส่ได้หลายตัวคั่นด้วยจุลภาค
    // ส่งเข้ากลุ่มประหยัดโควตากว่ามาก เพราะนับเป็น 1 ข้อความไม่ว่าในกลุ่มมีกี่คน
    lineToken: str(env.LINE_CHANNEL_TOKEN, ''),
    lineTo: str(env.LINE_TO, ''),
    lineBossTo: str(env.LINE_BOSS_TO, ''), // หัวหน้า (ใช้ตอน escalate) ว่างได้
    // ใช้ตรวจลายเซ็นของ webhook ที่ LINE ส่งมา ถ้าไม่ตั้งจะรับทุก request
    // ที่ยิงเข้ามาโดยไม่พิสูจน์ว่ามาจาก LINE จริง — ควรตั้งเสมอ
    lineChannelSecret: str(env.LINE_CHANNEL_SECRET, ''),

    // ---------- ช่วงที่เครื่องอ่านปิดแน่นอน ----------
    // เครื่องในโรงงานปิดทุกคืน ระบบจะขาดข้อมูลเป็นเรื่องปกติ ไม่ใช่ความผิดปกติ
    // ถ้าเตือนทุกคืนคนจะชินแล้วเลิกอ่าน ซึ่งอันตรายกว่าไม่เตือน
    quietStartHour: num(env.QUIET_START_HOUR, 3), // 03:00
    quietEndHour: num(env.QUIET_END_HOUR, 7.5), // 07:30

    // ไฟหลวงสูงกว่าตอนกด /ack เกินกี่ kW ถึงจะถือว่า "ที่ทำไปยังไม่พอ"
    // แล้วกลับมาเตือนใหม่ทันที ไม่รอให้ครบ ackSuppressMin
    ackReAlertKw: num(env.ACK_REALERT_KW, 1),
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

  // ---------- เพดานความสมเหตุสมผลของค่าที่อ่านได้ ----------
  //
  // 3 ส.ค. 2569 พอร์ทัลส่งค่าที่แปลงออกมาได้ 1,279 kW เข้ามาหนึ่งจุด
  // (โรงงานนี้มีอินเวอร์เตอร์ 36 kW เพดานการไฟฟ้า 20 kW — เป็นไปไม่ได้เลย)
  // ระบบรับไว้ทั้งดุ้น พีคของวัน พีคของเดือน และหน้าต่าง 15 นาที เสียหายหมด
  //
  // ค่าที่เป็นไปไม่ได้ทางกายภาพต้อง "ทิ้ง" ไม่ใช่ "ตัดยอด" เพราะการตัดยอดจะกลายเป็น
  // ค่าปลอมที่ดูสมเหตุสมผล แล้วไปโผล่เป็นพีคของเดือนแทน ซึ่งแยกไม่ออกจากของจริง
  cfg.maxPlausibleKw = num(env.MAX_PLAUSIBLE_KW, Math.max(cfg.systemKwp, cfg.demandLimitKw) * 2);

  return cfg;
}

function parseJsonObject(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
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
