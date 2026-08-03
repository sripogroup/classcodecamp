/**
 * ส่งข้อความเข้า LINE ผ่าน Messaging API
 *
 * ทำไมต้องมีตัวนี้ทั้งที่มี Telegram อยู่แล้ว: ที่โรงงานใช้ LINE กันอยู่แล้ว
 * และมีบอทที่ผูกกับพนักงานไว้แล้ว ส่วน Telegram ไม่มีใครใช้ — การแจ้งเตือน
 * ที่ต้องให้คนลงแอพใหม่ก่อน คือการแจ้งเตือนที่ไม่มีใครอ่าน
 *
 * ข้อจำกัดที่ต้องรู้: แพ็กฟรีของ LINE Messaging API ส่งได้เดือนละ 200 ข้อความ
 * (นับต่อผู้รับ ส่งหา 3 คน = 3 ข้อความ) ต่างจาก Telegram ที่ฟรีไม่จำกัด
 * ตัวกันสแปมใน analyze.js (REPEAT_MIN / ACK_SUPPRESS_MIN) จึงสำคัญกว่าเดิมมาก
 * ถ้าโควตาหมดกลางเดือน จะเงียบไปเลยโดยไม่มีสัญญาณเตือน
 */

const MAX_LEN = 4900; // LINE จำกัด 5000 ตัวอักษรต่อข้อความ

/**
 * ข้อความที่ระบบสร้างเป็น HTML แบบ Telegram (<b>...</b>) ซึ่ง LINE ไม่รองรับ
 * ถ้าส่งดิบ ๆ ผู้ใช้จะเห็นแท็กเต็มไปหมด ต้องถอดออกก่อน
 */
export function toPlainText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_LEN);
}

/** แยกรายชื่อผู้รับที่คั่นด้วยจุลภาค ตัดช่องว่างและค่าซ้ำออก */
function parseTargets(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** bossOnly = ส่งหาหัวหน้าคนเดียว ไม่เข้ากลุ่มพนักงาน (ใช้นอกเวลางาน) */
export async function sendLine(cfg, text, { toBoss = false, bossOnly = false } = {}) {
  if (!cfg.lineToken) return { ok: false, skipped: 'ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN' };

  const bossIds = parseTargets(cfg.lineBossTo);
  // ไม่มีปลายทางของหัวหน้า = ส่งเข้ากลุ่มตามเดิม ดีกว่าเงียบหายไปทั้งข้อความ
  const targets = bossOnly && bossIds.length ? [...bossIds] : parseTargets(cfg.lineTo);
  if (!bossOnly && toBoss) {
    for (const id of bossIds) {
      if (!targets.includes(id)) targets.push(id);
    }
  }
  if (!targets.length) return { ok: false, skipped: 'ยังไม่ได้ตั้ง LINE_TO' };

  const body = { type: 'text', text: toPlainText(text) };
  const results = [];

  // ส่งทีละคน ไม่ใช้ multicast เพราะ multicast รับได้เฉพาะ userId
  // ส่งเข้ากลุ่ม (groupId) ไม่ได้ ซึ่งเป็นปลายทางที่น่าจะใช้จริงที่สุด
  for (const to of targets) {
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.lineToken}`,
        },
        body: JSON.stringify({ to, messages: [body] }),
      });

      if (res.ok) {
        results.push({ to: to.slice(0, 6) + '...', ok: true });
      } else {
        const detail = await res.text().catch(() => '');
        // 429 = โควตาเดือนนี้หมด ซึ่งเงียบมากถ้าไม่ดู log
        results.push({
          to: to.slice(0, 6) + '...',
          ok: false,
          status: res.status,
          error: res.status === 429 ? 'โควตาข้อความ LINE เดือนนี้หมดแล้ว' : detail.slice(0, 200),
        });
      }
    } catch (err) {
      results.push({ to: to.slice(0, 6) + '...', ok: false, error: String(err?.message || err) });
    }
  }

  return { ok: results.some((r) => r.ok), results };
}
