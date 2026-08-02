/**
 * ทดสอบทั้งเส้นทางจริง: FusionSolar -> คิด demand -> ตัดสินใจ -> ส่ง Telegram -> เก็บ KV
 * โดยจำลอง (mock) ตัว API ข้างนอกทั้งหมด ไม่ต้องมีบัญชีจริง ไม่ต้องต่อเน็ต
 *
 * รันด้วย:  node test/integration.test.js
 *
 * เทสต์ชุดก่อนหน้าทดสอบ "ตรรกะ" แยกเป็นชิ้น ๆ
 * ชุดนี้ทดสอบว่า "ชิ้นส่วนทั้งหมดต่อกันแล้ววิ่งได้จริง" ซึ่งเป็นคนละเรื่องกัน
 */

import assert from 'node:assert';
import worker from '../src/index.js';

let pass = 0;
function test(name, fn) {
  return fn()
    .then(() => {
      pass++;
      console.log(`  ✅ ${name}`);
    })
    .catch((err) => {
      console.error(`  ❌ ${name}\n     ${err.message}`);
      process.exitCode = 1;
    });
}

/** KV จำลอง */
function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

/** FusionSolar + Telegram จำลอง — pvKw/gridKw ปรับได้ระหว่างเทสต์ */
function installFakeFetch(scenario) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? String(init.body) : '';

    if (u.includes('/thirdData/login')) {
      return new Response(JSON.stringify({ success: true, failCode: 0 }), { headers: { 'xsrf-token': 'fake-token' } });
    }
    if (u.includes('/thirdData/stations')) {
      return new Response(JSON.stringify({ success: true, data: { list: [{ plantCode: 'NE=TEST' }] } }));
    }
    if (u.includes('/thirdData/getDevList')) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [
            { id: 101, devName: 'INV-1', devTypeId: 1 },
            { id: 201, devName: 'Meter', devTypeId: 47 },
          ],
        }),
      );
    }
    if (u.includes('/thirdData/getDevRealKpi')) {
      const isMeter = body.includes('"devTypeId":47');
      return new Response(
        JSON.stringify({
          success: true,
          data: [
            isMeter
              ? { devId: 201, dataItemMap: { active_power: scenario.gridKw } }
              : { devId: 101, dataItemMap: { active_power: scenario.pvKw } },
          ],
        }),
      );
    }
    if (u.includes('/thirdData/getStationRealKpi')) {
      return new Response(JSON.stringify({ success: true, data: [{ dataItemMap: { day_power: 320 } }] }));
    }
    if (u.includes('api.telegram.org')) {
      sent.push(JSON.parse(body));
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }
    throw new Error(`fetch ที่ไม่ได้จำลองไว้: ${u}`);
  };
  return sent;
}

const ENV = {
  FUSION_USER: 'test',
  FUSION_SYSTEM_CODE: 'test',
  TELEGRAM_BOT_TOKEN: 'fake:token',
  TELEGRAM_CHAT_ID: '-100123',
  SITE_NAME: 'โรงงานทดสอบ',
  SYSTEM_KWP: '100',
  METER_SIGN: '1',
  WARN_IMPORT_KW: '20',
  CRIT_IMPORT_KW: '26',
  AUTOSHED_MODE: 'dryrun',
  ZONES: JSON.stringify([
    { id: 'ac1', name: 'แอร์ออฟฟิศชั้น 2', kw: 12, priority: 1, driver: 'pull' },
    { id: 'ac2', name: 'แอร์ห้องประชุม', kw: 6, priority: 2, driver: 'pull' },
    { id: 'srv', name: 'แอร์ห้องเซิร์ฟเวอร์', kw: 4, priority: 9, driver: 'pull', protected: true },
  ]),
};

const realNow = Date.now;
const call = (env, path) => worker.fetch(new Request(`https://x${path}`), env, { waitUntil() {} });

/** ยิงรอบเก็บข้อมูลหลายรอบ ห่างกัน 5 นาที ตามค่าที่กำหนด */
async function pollSeries(env, scenario, series, startAt) {
  const results = [];
  for (let i = 0; i < series.length; i++) {
    Date.now = () => startAt + i * 5 * 60000;
    scenario.pvKw = series[i][0];
    scenario.gridKw = series[i][1];
    const res = await call(env, '/api/poll');
    results.push(await res.json());
  }
  Date.now = realNow;
  return results;
}

const START = Date.parse('2026-08-03T06:00:00Z'); // 13:00 น. เวลาไทย

console.log('\nเส้นทางเต็มจาก FusionSolar ถึง Telegram');

await test('ดึงข้อมูลได้ คำนวณค่าครบ และเก็บลง KV', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const scenario = { pvKw: 60, gridKw: 5 };
  installFakeFetch(scenario);

  const [r] = await pollSeries(env, scenario, [[60, 5]], START);
  assert.equal(r.ok, true, `poll ล้มเหลว: ${r.error || ''}`);
  assert.equal(r.sample.pv, 60);
  assert.equal(r.sample.grid, 5);
  assert.equal(r.sample.load, 65, 'โหลดรวม = โซลาร์ + ไฟที่ซื้อ');
  assert.equal(r.level, 'green');
  assert.ok(r.window, 'ต้องมีข้อมูลหน้าต่าง 15 นาที');
  assert.ok(env.SOLAR_KV.store.has('state'), 'ต้องเก็บสถานะลง KV');
  assert.ok(env.SOLAR_KV.store.has('fusion:token'), 'ต้อง cache token ไว้ใช้ซ้ำ');
});

await test('ไฟปกติ ต้องไม่ส่งข้อความรบกวนใคร', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const scenario = {};
  const sent = installFakeFetch(scenario);
  await pollSeries(env, scenario, [[60, 4], [60, 5], [60, 4]], START);
  assert.equal(sent.length, 0, `ส่งไป ${sent.length} ข้อความ ทั้งที่ไฟปกติ`);
});

await test('ไฟหลวงพุ่งต่อเนื่อง -> ส่งข้อความที่บอกให้ไปปิดอะไร', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const scenario = {};
  const sent = installFakeFetch(scenario);
  await pollSeries(env, scenario, [[60, 4], [20, 28], [18, 29]], START);

  assert.ok(sent.length >= 1, 'ต้องมีข้อความออกไป');
  const all = sent.map((s) => s.text).join('\n---\n');
  assert.match(all, /kW/);
  assert.match(all, /ให้ทำตามลำดับนี้/, 'ต้องบอกว่าให้ไปปิดอะไร');
  assert.ok(!/undefined|NaN/.test(all), 'ต้องไม่มี undefined/NaN หลุดไปหาพนักงาน');
  assert.ok(sent.every((s) => s.chat_id === '-100123' && s.parse_mode === 'HTML'));
});

await test('ใกล้ชนเพดาน -> ต้องได้ข้อความเรื่องเพดาน และไม่ส่งซ้ำซ้อน 2 ใบพร้อมกัน', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const scenario = {};
  const sent = installFakeFetch(scenario);
  await pollSeries(env, scenario, [[10, 27], [8, 28], [8, 29]], START);

  const texts = sent.map((s) => s.text);
  const ceiling = texts.filter((t) => /ใกล้ชนเพดาน|จะเกิน 30 kW/.test(t));
  assert.ok(ceiling.length >= 1, 'ต้องมีข้อความเรื่องเพดาน');
  // ระหว่างที่เตือนเรื่องเพดานอยู่ สายค่าไฟต้องเงียบสนิท ไม่ใช่ส่งเรื่องเดียวกันซ้ำอีกใบ
  const comfort = texts.filter((t) => /ไฟหลวงเข้าหนัก|เริ่มดึงไฟหลวงเยอะ|ยังไม่ดีขึ้น/.test(t));
  assert.equal(comfort.length, 0, `สายค่าไฟส่งซ้ำ ${comfort.length} ใบทั้งที่เตือนเรื่องเพดานไปแล้ว`);
  assert.ok(texts.length <= 3, `ส่งไป ${texts.length} ใบใน 15 นาที ถือว่าถี่เกินไป`);

  // ตัวเลขในข้อความต้องไม่ขัดกันเอง: เตือนว่าใกล้ชนเพดาน แต่บอกว่าเหลือระยะเต็ม 30 kW ไม่ได้
  const first = ceiling[0];
  assert.ok(!/เหลือระยะ <b>30\.0 kW/.test(first), 'บอกว่าใกล้ชนเพดานแต่เหลือระยะเต็ม = ขัดกันเอง');
  assert.match(first, /ให้ทำตามลำดับนี้/, 'ข้อความที่ด่วนที่สุดต้องบอกว่าให้ไปปิดอะไร');
});

await test('โหมด dryrun ต้องบอกว่าจะปิดอะไร แต่ไม่แตะโซนที่ protected', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const scenario = {};
  const sent = installFakeFetch(scenario);
  const results = await pollSeries(env, scenario, [[5, 30], [5, 32], [5, 33]], START);

  const acted = results.filter((r) => r.autoshed && r.autoshed.actions.length);
  assert.ok(acted.length >= 1, 'ต้องมีการตัดสินใจตัดโหลด');
  const all = JSON.stringify(results);
  assert.ok(!/"id":"srv"/.test(all), 'ห้ามแตะแอร์ห้องเซิร์ฟเวอร์');
  assert.ok(acted[0].autoshed.actions.every((a) => a.result.dryRun === true), 'dryrun ต้องไม่สั่งจริง');
  assert.match(sent.map((s) => s.text).join(''), /ซ้อม/, 'ข้อความต้องบอกว่าเป็นการซ้อม');
});

console.log('\nAPI ที่อุปกรณ์ภายนอกเรียกใช้');

await test('/api/state ให้ตัวเลขครบสำหรับหน้าจอและไฟหมุน', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const scenario = {};
  installFakeFetch(scenario);
  await pollSeries(env, scenario, [[40, 22], [38, 24]], START);

  Date.now = () => START + 6 * 60000;
  const st = await (await call(env, '/api/state')).json();
  Date.now = realNow;

  assert.equal(st.stale, false);
  assert.ok(typeof st.siren === 'boolean');
  assert.ok(st.month && st.month.limitKw === 30, 'ต้องมีข้อมูลเพดานของเดือน');
  assert.ok(st.demand && typeof st.demand.remainMin === 'number', 'ต้องบอกว่าหน้าต่างเหลือกี่นาที');
  assert.ok(st.targets && st.targets.warnKw === 20);
});

await test('/api/zones ต้องสั่งเปิดทุกโซนเมื่อข้อมูลเก่า (fail-safe)', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const scenario = {};
  installFakeFetch(scenario);
  await pollSeries(env, scenario, [[5, 33], [5, 34], [5, 35]], START);

  // ผ่านไป 2 ชั่วโมงโดยไม่มีข้อมูลใหม่ = ระบบต้องไม่ปล่อยให้แอร์ปิดค้าง
  Date.now = () => START + 120 * 60000;
  const z = await (await call(env, '/api/zones')).json();
  Date.now = realNow;

  assert.equal(z.stale, true);
  assert.ok(Object.values(z.zones).every((v) => v.power === 'on'), 'ข้อมูลเก่าแล้วต้องเปิดทุกโซนกลับ');
});

await test('หน้าจอโหลดขึ้นและมีตัวเลขเพดานอยู่จริง', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  installFakeFetch({});
  const res = await call(env, '/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /เพดานการไฟฟ้าเดือนนี้/);
  assert.match(html, /หน้าต่าง 15 นาทีปัจจุบัน/);
});

console.log('\nความทนทานเมื่อของข้างนอกพัง');

await test('FusionSolar ล่ม -> ต้องไม่พัง ไม่เดาค่า และไม่สแปม', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify({ success: false, failCode: 407 }), { status: 200 });
  };
  Date.now = () => START;
  const r = await (await call(env, '/api/poll')).json();
  Date.now = realNow;

  assert.equal(r.ok, false, 'ต้องรายงานว่าล้มเหลว ไม่ใช่แกล้งว่าปกติ');
  assert.ok(r.error, 'ต้องมีข้อความบอกสาเหตุ');
  assert.equal(sent.length, 0, 'ล้มเหลวรอบแรกไม่ต้องรีบกวนใคร');
});

await test('token หมดอายุ -> ล็อกอินใหม่เองแล้วไปต่อได้', async () => {
  const env = { ...ENV, SOLAR_KV: fakeKV() };
  const scenario = { pvKw: 50, gridKw: 6 };
  const sent = installFakeFetch(scenario);
  const realFetch = globalThis.fetch;
  let expired = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('getDevList') && expired) {
      expired = false;
      return new Response(JSON.stringify({ success: false, failCode: 305 })); // token หมดอายุ
    }
    return realFetch(url, init);
  };

  Date.now = () => START;
  const r = await (await call(env, '/api/poll')).json();
  Date.now = realNow;

  assert.equal(r.ok, true, `ควรกู้คืนเองได้: ${r.error || ''}`);
  assert.equal(r.sample.grid, 6);
});

console.log(`\n${pass} เทสต์ผ่าน${process.exitCode ? ' (มีบางข้อไม่ผ่าน)' : ' ทั้งหมด ✨'}\n`);
