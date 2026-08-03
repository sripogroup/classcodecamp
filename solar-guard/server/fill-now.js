/**
 * เติมรูข้อมูลของวันนี้แล้วคิดสถิติใหม่ — สั่งเองได้ทุกเมื่อ
 *
 *   node server/fill-now.js            เติมของวันนี้
 *   node server/fill-now.js 2026-08-01 เติมตั้งแต่วันที่ระบุ
 *
 * ตัวเซิร์ฟเวอร์ทำงานนี้เองอยู่แล้วทุกครั้งที่เปิดเครื่อง ไฟล์นี้ไว้ใช้ตอนอยาก
 * เติมทันทีโดยไม่ต้องรีสตาร์ท หรือตอนย้อนไปเติมหลายวัน
 */
import { loadLocalConfig } from './config-local.js';
import { Store } from './store.js';
import { fillGaps, thaiMidnight } from './gapfill.js';
import { rebuildFromStore, applyRebuild } from './rebuild.js';

const cfg = loadLocalConfig();
const store = new Store(cfg.local.dbFile);
const log = (m, l = 'INFO') => console.log(`[${new Date().toLocaleString('sv-SE')}] ${l} ${m}`);

const day = process.argv[2] || null;
const since = thaiMidnight(day);
log(`เติมข้อมูลตั้งแต่ ${new Date(since + 7 * 3600000).toISOString().slice(0, 16)} (เวลาไทย)`);

const added = await fillGaps(store, cfg, log, { sinceMs: since, minGapMin: cfg.local.gapfillMinGapMin });
const built = rebuildFromStore(store, cfg);
if (built) {
  applyRebuild(store, built);
  log(`คิดใหม่จาก ${built.rows} จุด`);
  log(`  พีคเฉลี่ย 15 นาทีของเดือน : ${built.headroom.peakKw.toFixed(1)} kW / เพดาน ${built.headroom.limitKw}`);
  log(`  สูงสุดของเดือน            : ไฟหลวง ${built.monthPeaks.gridKw} · โหลด ${built.monthPeaks.loadKw} · โซลาร์ ${built.monthPeaks.pvKw} kW`);
  log(`  ค่าไฟเดือนนี้             : ${built.billMonth.totalBaht.toLocaleString('th-TH')} บาท (${built.billMonth.totalKwh} kWh)`);
} else {
  log('ไม่มีข้อมูลของเดือนนี้ให้คิด', 'WARN');
}
log(`เติมเข้าไป ${added} จุด`);
store.close();
