/** ส่งข้อความเข้ากลุ่ม Telegram (ฟรี ไม่จำกัดจำนวนข้อความ) */

/**
 * bossOnly = ส่งหาหัวหน้าคนเดียว ไม่เข้ากลุ่มพนักงาน
 *
 * ใช้นอกเวลางาน — เรื่องไฟยังต้องรู้ (พีคที่เกิดตอนสามทุ่มก็แพงเท่าตอนบ่าย)
 * แต่ไม่มีเหตุผลให้โทรศัพท์พนักงานทั้งกลุ่มสั่นตอนเขากลับบ้านไปแล้ว
 *
 * ถ้ายังไม่ได้ตั้งช่องของหัวหน้าไว้ จะส่งเข้ากลุ่มแบบไม่มีเสียงแทน
 * เพราะ "เงียบสนิทเพราะตั้งค่าไม่ครบ" อันตรายกว่ารบกวนผิดเวลา
 */
export async function sendTelegram(cfg, text, { toBoss = false, silent = false, bossOnly = false } = {}) {
  if (!cfg.telegramToken) return { ok: false, skipped: 'ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN' };

  const hasBoss = !!cfg.telegramBossChatId;
  const targets = [];
  if (bossOnly && hasBoss) {
    targets.push(cfg.telegramBossChatId);
  } else {
    if (cfg.telegramChatId) targets.push(cfg.telegramChatId);
    if (toBoss && hasBoss && cfg.telegramBossChatId !== cfg.telegramChatId) {
      targets.push(cfg.telegramBossChatId);
    }
  }
  if (!targets.length) return { ok: false, skipped: 'ยังไม่ได้ตั้ง TELEGRAM_CHAT_ID' };
  // ตกมาที่กลุ่มเพราะไม่มีช่องหัวหน้า -> อย่างน้อยอย่าให้มีเสียง
  if (bossOnly && !hasBoss) silent = true;

  const results = [];
  for (const chatId of targets) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: silent,
        }),
      });
      const body = await res.json().catch(() => null);
      results.push({ chatId, ok: !!body?.ok, error: body?.description });
    } catch (err) {
      results.push({ chatId, ok: false, error: String(err) });
    }
  }

  return { ok: results.some((r) => r.ok), results };
}

/**
 * ตอบกลับเข้าห้องที่พิมพ์คำสั่งมา
 *
 * ต่างจาก sendTelegram ตรงที่ไม่สนใจว่าห้องนั้นคือกลุ่มพนักงานหรือของหัวหน้า
 * — ใครพิมพ์มาจากไหน ตอบกลับที่นั่น
 *
 * ก่อนหน้านี้คำสั่งทุกตัวตอบผ่าน sendTelegram ซึ่งยิงเข้ากลุ่มเสมอ แปลว่า
 * ถ้าพิมพ์ /status ในห้องส่วนตัว คำตอบจะไปโผล่ในกลุ่มพนักงานแทน คนถามนั่งรอ
 * หน้าจอเปล่า ๆ แล้วนึกว่าบอทตาย (เจอจริงคืน 3 ส.ค. 69)
 */
export async function replyTelegram(cfg, chatId, text, { silent = false } = {}) {
  if (!cfg.telegramToken || !chatId) return { ok: false, skipped: 'ไม่มีโทเคนหรือห้องปลายทาง' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: silent,
      }),
    });
    const body = await res.json().catch(() => null);
    return { ok: !!body?.ok, error: body?.description };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** รายการคำสั่งที่ให้ Telegram แสดงเป็นเมนูตอนพิมพ์ "/" ในกลุ่ม */
const COMMANDS = [
  { command: 'status', description: 'ดูสถานะตอนนี้ + สูงสุดของเดือน' },
  { command: 'ack', description: 'รับเรื่องแล้ว กำลังไปจัดการ' },
  { command: 'done', description: 'ปิดแอร์ตามรอบแล้ว' },
  { command: 'restore', description: 'เปิดอุปกรณ์ที่ถูกสั่งปิดกลับ' },
  { command: 'id', description: 'บอกเลขห้องแชทนี้ (ใช้ตอนตั้งค่า)' },
  { command: 'help', description: 'ดูคำสั่งทั้งหมด' },
];

/** ตั้ง webhook ให้บอทรับคำสั่ง /ack /status /mute พร้อมลงทะเบียนเมนูคำสั่ง */
export async function setTelegramWebhook(cfg, workerUrl) {
  if (!cfg.telegramToken) throw new Error('ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN');
  const api = (m) => `https://api.telegram.org/bot${cfg.telegramToken}/${m}`;

  // ลบของเก่าทิ้งก่อนเสมอ
  //
  // ถ้า URL ไม่เปลี่ยน Telegram จะตอบว่า "Webhook is already set" แล้วไม่
  // อัปเดต secret_token ให้ ซึ่งเป็นกับดักเงียบสนิท: Worker เริ่มเรียกร้อง
  // รหัสลับ แต่ Telegram ยังยิงของเก่าที่ไม่มีรหัสมา คำสั่งทุกอย่างเลยโดน
  // ปฏิเสธ 401 โดยไม่มีอะไรฟ้อง บอทแค่เงียบไปเฉย ๆ เจอมาแล้วจริง 3 ส.ค. 69
  await fetch(api('deleteWebhook')).catch(() => {});

  const res = await fetch(api('setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${workerUrl.replace(/\/+$/, '')}/telegram/webhook`,
      secret_token: cfg.telegramWebhookSecret || undefined,
      allowed_updates: ['message'],
    }),
  });
  const hook = await res.json();

  // ลงทะเบียนเมนูคำสั่ง เพื่อให้ปุ่ม "/" ในแอพขึ้นรายการให้เลือก
  // พนักงานจะได้ไม่ต้องจำว่ามีคำสั่งอะไรบ้าง
  let commands = null;
  try {
    const r = await fetch(api('setMyCommands'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: COMMANDS }),
    });
    commands = await r.json();
  } catch (err) {
    commands = { ok: false, description: String(err?.message || err) };
  }

  return { webhook: hook, commands };
}
