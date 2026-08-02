/**
 * ส่งข้อความแชทออกทุกช่องทางที่ตั้งค่าไว้
 *
 * มีไว้เพื่อให้โค้ดส่วนอื่นไม่ต้องรู้ว่ามีกี่ช่องทาง — เพิ่ม LINE เข้ามาทีหลัง
 * โดยไม่ต้องไล่แก้ทุกจุดที่เรียกส่งข้อความ และถ้าวันหนึ่งเลิกใช้ช่องทางไหน
 * ก็แค่ไม่ตั้งค่าของช่องทางนั้น ตัวที่เหลือยังทำงานต่อได้
 *
 * ช่องทางไหนไม่ได้ตั้งค่าจะคืน skipped ไม่ถือว่าพัง
 */

import { sendTelegram } from './telegram.js';
import { sendLine } from './line.js';

export async function sendChat(cfg, text, opts = {}) {
  const telegram = await sendTelegram(cfg, text, opts);
  const line = await sendLine(cfg, text, opts);

  return {
    ok: Boolean(telegram.ok || line.ok),
    telegram,
    line,
  };
}
