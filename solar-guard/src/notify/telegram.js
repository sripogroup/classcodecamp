/** ส่งข้อความเข้ากลุ่ม Telegram (ฟรี ไม่จำกัดจำนวนข้อความ) */

export async function sendTelegram(cfg, text, { toBoss = false, silent = false } = {}) {
  if (!cfg.telegramToken) return { ok: false, skipped: 'ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN' };

  const targets = [];
  if (cfg.telegramChatId) targets.push(cfg.telegramChatId);
  if (toBoss && cfg.telegramBossChatId && cfg.telegramBossChatId !== cfg.telegramChatId) {
    targets.push(cfg.telegramBossChatId);
  }
  if (!targets.length) return { ok: false, skipped: 'ยังไม่ได้ตั้ง TELEGRAM_CHAT_ID' };

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

/** รายการคำสั่งที่ให้ Telegram แสดงเป็นเมนูตอนพิมพ์ "/" ในกลุ่ม */
const COMMANDS = [
  { command: 'status', description: 'ดูสถานะตอนนี้ + สูงสุดของเดือน' },
  { command: 'ack', description: 'รับเรื่องแล้ว กำลังไปจัดการ' },
  { command: 'done', description: 'ปิดแอร์ตามรอบแล้ว' },
  { command: 'restore', description: 'เปิดอุปกรณ์ที่ถูกสั่งปิดกลับ' },
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
