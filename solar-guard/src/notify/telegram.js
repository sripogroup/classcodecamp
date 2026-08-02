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

/** ตั้ง webhook ให้บอทรับคำสั่ง /ack /status /mute */
export async function setTelegramWebhook(cfg, workerUrl) {
  if (!cfg.telegramToken) throw new Error('ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN');
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${workerUrl.replace(/\/+$/, '')}/telegram/webhook`,
      secret_token: cfg.telegramWebhookSecret || undefined,
      allowed_updates: ['message'],
    }),
  });
  return res.json();
}
