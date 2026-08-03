/**
 * นอกเวลางาน ห้ามกวนกลุ่มพนักงาน — แต่ต้องไม่เงียบ
 *
 * เทสต์ชุดนี้มีไว้กันความผิดพลาดสองแบบที่อันตรายพอ ๆ กัน:
 *   1. หลังหนึ่งทุ่มแล้วยังยิงเข้ากลุ่มพนักงาน (สิ่งที่พ่อเต้ยสั่งไม่ให้ทำ)
 *   2. หลังหนึ่งทุ่มแล้วเงียบสนิท ทั้งที่ on-peak ยาวถึงสี่ทุ่ม พีคที่เกิด
 *      ตอนสองทุ่มคิดเงินเท่าตอนบ่ายทุกบาท
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaffHours } from '../src/util.js';
import { sendTelegram } from '../src/notify/telegram.js';
import { sendLine } from '../src/notify/line.js';

const cfg = { staffHourStart: 8, staffHourEnd: 19 };

// เวลาไทย -> epoch ms (ไทย = UTC+7 ตลอดปี)
const at = (hour, minute = 0) => Date.parse(`2026-08-04T${String(hour - 7).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);

console.log('\nช่วงเวลาที่ยอมให้รบกวนพนักงาน');

test('กลางวันในเวลางาน = รบกวนได้', () => {
  assert.equal(isStaffHours(cfg, at(8)), true);
  assert.equal(isStaffHours(cfg, at(13)), true);
  assert.equal(isStaffHours(cfg, at(18, 59)), true);
});

test('ตั้งแต่หนึ่งทุ่มถึงแปดโมงเช้า = ห้ามรบกวน', () => {
  assert.equal(isStaffHours(cfg, at(19)), false, '19:00 ตรงต้องเงียบแล้ว');
  assert.equal(isStaffHours(cfg, at(21, 30)), false);
  assert.equal(isStaffHours(cfg, at(2)), false);
  assert.equal(isStaffHours(cfg, at(7, 59)), false);
});

test('ตั้งเวลาเริ่มกับจบเท่ากัน = ไม่จำกัดเวลา (ปิดฟีเจอร์)', () => {
  const always = { staffHourStart: 0, staffHourEnd: 0 };
  assert.equal(isStaffHours(always, at(3)), true);
  assert.equal(isStaffHours(always, at(23)), true);
});

console.log('\nปลายทางของข้อความนอกเวลางาน');

/** ดักการยิงออกเน็ต แล้วบอกว่ายิงไปหาใครบ้าง */
function captureFetch(fn) {
  const real = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url, opt) => {
    hits.push({ url: String(url), body: JSON.parse(opt?.body || '{}') });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
  return fn().finally(() => { globalThis.fetch = real; }).then(() => hits);
}

const chatCfg = {
  telegramToken: 'T',
  telegramChatId: 'GROUP',
  telegramBossChatId: 'BOSS',
  lineToken: 'L',
  lineTo: 'lineGroup',
  lineBossTo: 'lineBoss',
};

test('Telegram: bossOnly ส่งหาหัวหน้าคนเดียว ไม่แตะกลุ่ม', async () => {
  const hits = await captureFetch(() => sendTelegram(chatCfg, 'ทดสอบ', { bossOnly: true }));
  const ids = hits.map((h) => h.body.chat_id);
  assert.deepEqual(ids, ['BOSS']);
});

test('Telegram: ในเวลางานส่งเข้ากลุ่มตามเดิม', async () => {
  const hits = await captureFetch(() => sendTelegram(chatCfg, 'ทดสอบ', {}));
  assert.deepEqual(hits.map((h) => h.body.chat_id), ['GROUP']);
});

test('LINE: bossOnly ส่งหาหัวหน้าคนเดียว', async () => {
  const hits = await captureFetch(() => sendLine(chatCfg, 'ทดสอบ', { bossOnly: true }));
  assert.deepEqual(hits.map((h) => h.body.to), ['lineBoss']);
});

test('ยังไม่ได้ตั้งช่องหัวหน้า -> ส่งเข้ากลุ่มแบบไม่มีเสียง ไม่ใช่เงียบหาย', async () => {
  const noBoss = { ...chatCfg, telegramBossChatId: '', lineBossTo: '' };
  const tg = await captureFetch(() => sendTelegram(noBoss, 'ทดสอบ', { bossOnly: true }));
  assert.deepEqual(tg.map((h) => h.body.chat_id), ['GROUP'], 'ต้องยังส่งถึงใครสักคน');
  assert.equal(tg[0].body.disable_notification, true, 'แต่ต้องไม่มีเสียง');

  const line = await captureFetch(() => sendLine(noBoss, 'ทดสอบ', { bossOnly: true }));
  assert.deepEqual(line.map((h) => h.body.to), ['lineGroup']);
});
