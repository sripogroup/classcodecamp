/**
 * ส่งข้อความแจ้งเตือนโดยผ่านทาง Cloudflare
 *
 * ทำไมไม่ส่ง Telegram ตรง ๆ จากเครื่องนี้: โทเคนของบอทเก็บเป็น wrangler secret
 * ซึ่งอ่านกลับออกมาไม่ได้ตามที่ควรจะเป็น ถ้าจะส่งเองต้องก๊อปโทเคนมาวางไว้บน
 * เครื่องอีกชุด = มีความลับสองที่ที่ต้องคอยหมุนพร้อมกัน วันหนึ่งจะลืมหมุนที่หนึ่ง
 *
 * ปลายทาง /api/notify บนคลาวด์ไม่แตะ KV เลย จึงไม่กินโควตาเขียน 1,000 ครั้ง/วัน
 * (โควตาอ่าน/จำนวน request คือ 100,000 ต่อวัน ซึ่งเหลือเฟือ)
 *
 * ถ้าเน็ตล่ม ส่งไม่ได้ทั้งสองทางอยู่แล้ว — จึงไม่ได้แย่ลงกว่าการส่งเอง
 */

export function makeRelay(cfg, log) {
  const base = (cfg.local.workerUrl || '').replace(/\/$/, '');
  const token = cfg.local.ingestToken;

  if (!base || !token) {
    log('ยังไม่ได้ตั้ง WORKER_URL / INGEST_TOKEN — จะไม่ส่งแจ้งเตือนออกไปไหน', 'WARN');
    return async (text) => { log(`[ส่งไม่ได้] ${text.split('\n')[0]}`, 'WARN'); return { ok: false }; };
  }

  return async function relay(text, { toBoss = false, silent = false, emailSubject = null, emailHtml = null } = {}) {
    try {
      const res = await fetch(`${base}/api/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
        body: JSON.stringify({ text, toBoss, silent, emailSubject, emailHtml }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.ok === false) {
        log(`ส่งข้อความไม่สำเร็จ: HTTP ${res.status} ${out.error || ''}`, 'ERROR');
        return { ok: false };
      }
      return out;
    } catch (err) {
      log(`ส่งข้อความไม่สำเร็จ: ${err.message}`, 'ERROR');
      return { ok: false };
    }
  };
}
