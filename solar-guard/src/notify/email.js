/**
 * ส่งอีเมล ผ่านผู้ให้บริการที่มีแพ็กฟรี (เลือกอันไหนก็ได้ ใส่ API key อันเดียวพอ)
 *   - Resend : ฟรี 3,000 ฉบับ/เดือน (100/วัน) ต้องยืนยันโดเมนหรือใช้ onboarding@resend.dev ทดสอบ
 *   - Brevo  : ฟรี 300 ฉบับ/วัน
 * ทั้งคู่เป็น HTTP API ล้วน ๆ ใช้บน Cloudflare Workers ได้เลย ไม่ต้องมี SMTP
 */

export async function sendEmail(cfg, subject, html) {
  if (!subject || !html) return { ok: false, skipped: 'ไม่มีเนื้อหาอีเมล' };
  if (!cfg.mailTo.length || !cfg.mailFrom) return { ok: false, skipped: 'ยังไม่ได้ตั้ง MAIL_FROM / MAIL_TO' };

  if (cfg.resendApiKey) return sendViaResend(cfg, subject, html);
  if (cfg.brevoApiKey) return sendViaBrevo(cfg, subject, html);
  return { ok: false, skipped: 'ยังไม่ได้ตั้ง RESEND_API_KEY หรือ BREVO_API_KEY' };
}

async function sendViaResend(cfg, subject, html) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.mailFrom, to: cfg.mailTo, subject, html }),
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, provider: 'resend', body };
  } catch (err) {
    return { ok: false, provider: 'resend', error: String(err) };
  }
}

async function sendViaBrevo(cfg, subject, html) {
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': cfg.brevoApiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: cfg.mailFrom, name: 'Solar Guard' },
        to: cfg.mailTo.map((email) => ({ email })),
        subject,
        htmlContent: html,
      }),
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, provider: 'brevo', body };
  } catch (err) {
    return { ok: false, provider: 'brevo', error: String(err) };
  }
}
