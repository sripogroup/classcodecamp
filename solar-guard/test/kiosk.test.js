/**
 * ทดสอบตัวอ่านข้อมูลจาก Kiosk View
 * รันด้วย:  node test/kiosk.test.js
 *
 * จุดสำคัญ: เราไม่รู้หน้าตาข้อมูลจริงของ Kiosk ตอนเขียน
 * เทสต์นี้จึงเน้นว่า "เจอฟิลด์อะไรก็ต้องไม่พัง และต้องไม่เดาค่าที่ไม่มี"
 */

import assert from 'node:assert';
import { loadConfig } from '../src/config.js';
import { flattenNumbers, guessFields, kioskApiUrl, readNowFromKiosk } from '../src/kiosk.js';

let pass = 0;
function test(name, fn) {
  const run = () => {
    pass++;
    console.log(`  ✅ ${name}`);
  };
  const res = fn();
  return res instanceof Promise
    ? res.then(run).catch((e) => {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        process.exitCode = 1;
      })
    : (() => {
        try {
          run();
        } catch (e) {
          console.error(`  ❌ ${name}\n     ${e.message}`);
          process.exitCode = 1;
        }
      })();
}

const KK = 'GCoNqGGzsaCiEO70KB201nPki3wyLj04';
const base = { FUSION_BASE: 'https://sg5.fusionsolar.huawei.com', KIOSK_KEY: KK, DATA_SOURCE: 'kiosk' };

/** จำลองการตอบกลับของ Kiosk (data เป็นสตริง JSON ซ้อนอีกชั้นตามที่ Huawei ทำ) */
function fakeKiosk(inner) {
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: JSON.stringify(inner) }));
}

console.log('\nพื้นฐาน');

test('ประกอบ URL ของ REST endpoint ถูกต้อง', () => {
  const url = kioskApiUrl(loadConfig(base));
  assert.match(url, /^https:\/\/sg5\.fusionsolar\.huawei\.com\/rest\/pvms\/web\/kiosk\/v1\/station-kiosk-file\?kk=/);
  assert.ok(url.endsWith(KK));
});

test('ไล่หาตัวเลขได้ทุกชั้น รวมถึงตัวเลขที่มาเป็นสตริง', () => {
  const flat = flattenNumbers({ realKpi: { realTimePower: '12.5', dailyEnergy: 88 }, deep: { a: { b: { c: 3 } } } });
  assert.equal(flat['realKpi.realTimePower'], 12.5);
  assert.equal(flat['realKpi.dailyEnergy'], 88);
  assert.equal(flat['deep.a.b.c'], 3);
});

test('อาเรย์กราฟยาว ๆ เก็บแค่ค่าล่าสุด ไม่ระเบิดใส่หน้าจอ', () => {
  const flat = flattenNumbers({ powerCurve: { activePower: [1, 2, 3, 4, 9.5] } });
  assert.equal(flat['powerCurve.activePower[ล่าสุด]'], 9.5);
  assert.equal(flat['powerCurve.activePower[จำนวน]'], 5);
});

console.log('\nการเดาว่าฟิลด์ไหนคืออะไร');

test('แยกฝั่งผลิต / ซื้อไฟ / โหลด ออกจากกันได้', () => {
  const g = guessFields({
    'realKpi.realTimePower': 12,
    'realKpi.gridPower': 8,
    'realKpi.usePower': 20,
    'realKpi.co2Reduction': 5,
  });
  assert.ok(g.pv.includes('realKpi.realTimePower'));
  assert.ok(g.grid.includes('realKpi.gridPower'));
  assert.ok(g.load.includes('realKpi.usePower'));
  assert.ok(g.other.includes('realKpi.co2Reduction'));
});

console.log('\nกรณีที่ Kiosk มีแต่ข้อมูลฝั่งผลิต (ที่คาดว่าจะเจอจริง)');

await test('มีแค่กำลังผลิต -> ต้องบอกว่าวัดไม่ได้ ไม่ใช่เดาว่าเป็น 0', async () => {
  fakeKiosk({ realKpi: { realTimePower: '12.5', dailyEnergy: 88, monthlyEnergy: 1200 } });
  const cfg = loadConfig({ ...base, KIOSK_FIELD_MAP: JSON.stringify({ pv: 'realKpi.realTimePower' }) });
  const r = await readNowFromKiosk(cfg);
  assert.equal(r.pvKw, 12.5);
  assert.equal(r.gridImportKw, null, 'ไม่มีข้อมูลซื้อไฟ ต้องเป็น null');
  assert.equal(r.meterFound, false, 'ต้องบอกว่าใช้ไม่ได้ เพื่อให้ชั้นบนไม่เตือนมั่ว');
});

console.log('\nกรณีที่ Kiosk มีข้อมูลฝั่งใช้ไฟด้วย (ถ้าโชคดี)');

await test('มีทั้งผลิตและซื้อไฟ -> คำนวณโหลดรวมให้เอง', async () => {
  fakeKiosk({ realKpi: { realTimePower: '20', gridPower: '8' } });
  const cfg = loadConfig({
    ...base,
    KIOSK_FIELD_MAP: JSON.stringify({ pv: 'realKpi.realTimePower', grid: 'realKpi.gridPower' }),
  });
  const r = await readNowFromKiosk(cfg);
  assert.equal(r.gridImportKw, 8);
  assert.equal(r.loadKw, 28, 'โหลดรวม = ผลิต + ซื้อ');
  assert.equal(r.meterFound, true);
});

await test('มีผลิตกับโหลดรวม -> คำนวณไฟที่ซื้อให้เอง', async () => {
  fakeKiosk({ realKpi: { realTimePower: '20', usePower: '28' } });
  const cfg = loadConfig({
    ...base,
    KIOSK_FIELD_MAP: JSON.stringify({ pv: 'realKpi.realTimePower', load: 'realKpi.usePower' }),
  });
  const r = await readNowFromKiosk(cfg);
  assert.equal(r.gridImportKw, 8);
  assert.equal(r.meterFound, true);
});

await test('มิเตอร์นับกลับทาง -> METER_SIGN ต้องมีผลเหมือนทาง API ปกติ', async () => {
  fakeKiosk({ realKpi: { realTimePower: '20', gridPower: '-8' } });
  const cfg = loadConfig({
    ...base,
    METER_SIGN: '-1',
    KIOSK_FIELD_MAP: JSON.stringify({ pv: 'realKpi.realTimePower', grid: 'realKpi.gridPower' }),
  });
  const r = await readNowFromKiosk(cfg);
  assert.equal(r.gridImportKw, 8);
});

console.log('\nความทนทาน');

await test('URL หมดอายุ / ถูกปิด -> โยน error ที่อ่านรู้เรื่อง ไม่ใช่พังเงียบ ๆ', async () => {
  globalThis.fetch = async () => new Response('<html>expired</html>', { status: 200 });
  const cfg = loadConfig(base);
  await assert.rejects(() => readNowFromKiosk(cfg), /ไม่ใช่ JSON|หมดอายุ/);
});

await test('เซิร์ฟเวอร์ตอบ error -> บอก HTTP status', async () => {
  globalThis.fetch = async () => new Response('nope', { status: 403 });
  await assert.rejects(() => readNowFromKiosk(loadConfig(base)), /403/);
});

await test('ยังไม่ได้ตั้ง KIOSK_FIELD_MAP -> ไม่พัง แต่บอกว่าใช้ไม่ได้', async () => {
  fakeKiosk({ realKpi: { realTimePower: '12' } });
  const r = await readNowFromKiosk(loadConfig(base));
  assert.equal(r.meterFound, false);
  assert.ok(r.availableFields >= 1, 'ยังต้องบอกได้ว่าเจอกี่ฟิลด์ เพื่อเอาไปตั้งค่าต่อ');
});

console.log(`\n${pass} เทสต์ผ่าน${process.exitCode ? ' (มีบางข้อไม่ผ่าน)' : ' ทั้งหมด ✨'}\n`);
