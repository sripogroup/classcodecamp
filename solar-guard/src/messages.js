/**
 * สร้างข้อความภาษาไทยสำหรับแต่ละเหตุการณ์
 *
 * กติกาการเขียนข้อความ (สำคัญกว่าโค้ด):
 *   - พาดหัวบอก "ต้องทำอะไร" ไม่ใช่แค่ "เกิดอะไรขึ้น"
 *   - ตัวเลขต้องอ่านจบใน 3 วินาที
 *   - ต้องมีรายการสิ่งที่ให้ไปปิด พร้อมตัวเลข kW และคนรับผิดชอบ
 *   - ต้องมีตัวเลขเงิน เพราะ "154 บาท/ชม." สะกิดใจกว่า "34 kW"
 */

import { hhmm, isTouOnPeak, round1, tariffNow, thDateThai } from './util.js';

const esc = (s) =>
  String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const kw = (n) => `${round1(n)} kW`;
const baht = (n) => `${Math.round(n).toLocaleString('th-TH')} บาท`;

/** แถบตัวเลขหลักที่ใช้ซ้ำในทุกข้อความ */
function statBlock(sample, cfg) {
  const coverage = sample.load > 0 ? Math.round(((sample.load - Math.max(0, sample.grid)) / sample.load) * 100) : 0;
  return [
    `⚡ ดึงไฟจากการไฟฟ้า <b>${kw(sample.grid)}</b>`,
    `☀️ โซลาร์ผลิต ${kw(sample.pv)}  |  🏭 โหลดรวม ${kw(sample.load)}`,
    `🔋 โซลาร์ครอบคลุมโหลด <b>${coverage}%</b>`,
  ].join('\n');
}

function moneyLine(sample, cfg, ts) {
  const rate = tariffNow(cfg, ts);
  const perHour = Math.max(0, sample.grid) * rate;
  const peakTag = cfg.useTou ? (isTouOnPeak(cfg, ts) ? ' (ช่วง On Peak ค่าไฟแพง)' : ' (ช่วง Off Peak)') : '';
  return `💸 ถ้าปล่อยไว้แบบนี้ ≈ <b>${baht(perHour)}/ชั่วโมง</b>${peakTag}`;
}

function actionBlock(actions) {
  if (!actions.length) return '';
  const lines = actions.map(
    (a, i) => `${i + 1}. ${esc(a.name)} <b>(−${round1(a.kw)} kW)</b>${a.owner ? ` — ${esc(a.owner)}` : ''}`,
  );
  return `\n\n✅ <b>ให้ทำตามลำดับนี้</b>\n${lines.join('\n')}`;
}

const ackFooter = '\n\n<i>ทำแล้วพิมพ์ /ack ในกลุ่มนี้ ระบบจะหยุดเตือนซ้ำ 1 ชั่วโมง</i>';

export function buildMessage(event, cfg, now = Date.now()) {
  const sample = event.sample || { pv: 0, grid: 0, load: 0 };
  const cause = event.cause || { text: '' };
  const actions = event.actions || []; // รายการที่ให้ "คน" ไปปิด (คนละอันกับ event.changes ที่ระบบสั่งเอง)
  const time = hhmm(now);
  const site = esc(cfg.siteName);

  switch (event.type) {
    case 'alert': {
      const red = event.level === 'red';
      const head = red
        ? `🔴 <b>ไฟหลวงเข้าหนัก — ลดการใช้ไฟตอนนี้</b>`
        : `🟡 <b>เริ่มดึงไฟหลวงเยอะ — เตรียมลดการใช้ไฟ</b>`;
      const body = [
        `${head}`,
        `${site} • ${time} น.`,
        '',
        statBlock(sample, cfg),
        `📉 สาเหตุ: ${esc(cause.text)}`,
        moneyLine(sample, cfg, now),
      ].join('\n');
      return {
        priority: red ? 'high' : 'normal',
        telegram: body + actionBlock(actions) + ackFooter,
        emailSubject: `${red ? '🔴 ด่วน' : '🟡 เฝ้าระวัง'} ${cfg.siteName}: ดึงไฟจากการไฟฟ้า ${kw(sample.grid)} (${time} น.)`,
        emailHtml: htmlWrap(body + actionBlock(actions), red ? '#dc2626' : '#d97706'),
      };
    }

    case 'repeat': {
      const body = [
        `🔁 <b>ยังไม่ดีขึ้น — ${event.level === 'red' ? 'ยังดึงไฟหลวงหนักอยู่' : 'ยังใช้ไฟเกินเกณฑ์'}</b>`,
        `${site} • ${time} น.`,
        '',
        statBlock(sample, cfg),
        moneyLine(sample, cfg, now),
      ].join('\n');
      return {
        priority: event.level === 'red' ? 'high' : 'normal',
        telegram: body + actionBlock(actions) + ackFooter,
        emailSubject: `${cfg.siteName}: ยังดึงไฟหลวง ${kw(sample.grid)} (${time} น.)`,
        emailHtml: htmlWrap(body + actionBlock(actions), '#dc2626'),
      };
    }

    case 'recover': {
      const body = [
        `🟢 <b>กลับสู่ปกติแล้ว</b>`,
        `${site} • ${time} น.`,
        '',
        statBlock(sample, cfg),
        '',
        'เปิดแอร์/อุปกรณ์ที่ปิดไปกลับมาใช้งานได้ตามปกติ ขอบคุณครับ 🙏',
      ].join('\n');
      return { priority: 'low', telegram: body, emailSubject: null, emailHtml: null };
    }

    case 'escalate': {
      const body = [
        `🚨 <b>แจ้งหัวหน้า: ไฟหลวงเข้าหนักต่อเนื่อง ${event.minutesRed} นาที</b>`,
        `${site} • ${time} น. • ยังไม่มีใครกดรับเรื่อง`,
        '',
        statBlock(sample, cfg),
        moneyLine(sample, cfg, now),
      ].join('\n');
      return {
        priority: 'high',
        toBoss: true,
        telegram: body + actionBlock(actions),
        emailSubject: `🚨 ${cfg.siteName}: ไฟหลวงเข้าหนัก ${event.minutesRed} นาที ยังไม่มีคนดำเนินการ`,
        emailHtml: htmlWrap(body + actionBlock(actions), '#991b1b'),
      };
    }

    case 'demand_risk': {
      const w = event.window;
      const h = event.headroom;
      const head = w.hardBlown
        ? `🆘 <b>หน้าต่าง 15 นาทีนี้จะเกิน ${cfg.demandLimitKw} kW แล้ว — ปิดทุกอย่างที่ปิดได้เดี๋ยวนี้</b>`
        : `🆘 <b>ใกล้ชนเพดาน ${cfg.demandLimitKw} kW — ต้องกดลงภายใน ${w.remainMin} นาที</b>`;
      const body = [
        head,
        `${site} • ${time} น.`,
        '',
        `⏱ หน้าต่าง 15 นาทีนี้ผ่านไป ${w.elapsedMin} นาที เหลืออีก <b>${w.remainMin} นาที</b>`,
        `📊 ตอนนี้เฉลี่ยได้ ${kw(w.avgSoFarKw)} — ถ้าใช้ต่อแบบนี้จะจบที่ <b>${kw(w.projectedKw)}</b>`,
        w.remainMin > 0
          ? `🎯 เวลาที่เหลือใช้ได้เฉลี่ยไม่เกิน <b>${kw(Math.max(0, w.allowedRestKw))}</b> เท่านั้น`
          : `⚠️ หน้าต่างนี้กำลังจะปิด`,
        '',
        `📅 พีคของเดือนนี้ ${kw(h.livePeakKw)}${h.liveIsCurrent ? ' (นับหน้าต่างที่กำลังเดินอยู่)' : ''} / เพดาน ${kw(h.limitKw)} — เหลือระยะ <b>${kw(h.headroomKw)}</b>`,
        '',
        `❗ ถ้าหน้าต่างไหนแตะ ${cfg.demandLimitKw} kW แม้ครั้งเดียว จะถูกย้ายไปค่าไฟประเภทที่ 3 นาน 12 เดือน`,
      ].join('\n');
      return {
        priority: 'high',
        toBoss: true,
        telegram: body + actionBlock(actions) + ackFooter,
        emailSubject: `🆘 ${cfg.siteName}: ใกล้ชนเพดาน ${cfg.demandLimitKw} kW (คาดจบที่ ${kw(w.projectedKw)})`,
        emailHtml: htmlWrap(body + actionBlock(actions), '#dc2626'),
      };
    }

    case 'demand_newpeak': {
      const h = event.headroom;
      const w = event.closedWindow;
      const body = [
        `📈 <b>ทำสถิติพีคใหม่ของเดือนนี้ ${kw(w.avgKw)}</b>`,
        `${site} • หน้าต่างเวลา ${hhmm(w.start)} น.`,
        '',
        `📅 พีคเดือนนี้ตอนนี้อยู่ที่ <b>${kw(h.peakKw)}</b> จากเพดาน ${kw(h.limitKw)}`,
        `📏 เหลือระยะปลอดภัยอีก <b>${kw(h.headroomKw)}</b> (ใช้ไปแล้ว ${h.usedPct}% ของเพดาน)`,
        '',
        `ตัวเลขนี้ค้างไปทั้งเดือน กดลงทีหลังไม่ได้ — เดือนหน้าถึงจะเริ่มนับใหม่`,
      ].join('\n');
      return {
        priority: h.headroomKw <= 3 ? 'high' : 'normal',
        telegram: body,
        emailSubject: `📈 ${cfg.siteName}: พีคใหม่ของเดือน ${kw(w.avgKw)} (เหลือระยะ ${kw(h.headroomKw)})`,
        emailHtml: htmlWrap(body, '#d97706'),
      };
    }

    case 'demand_breached': {
      const h = event.headroom;
      const body = [
        `🛑 <b>เดือนนี้เกินเพดาน ${cfg.demandLimitKw} kW ไปแล้ว</b>`,
        `${site} • ${time} น.`,
        '',
        `พีคของเดือน ${esc(h.monthKey)} อยู่ที่ <b>${kw(h.peakKw)}</b>`,
        '',
        `ผลที่ตามมา: จะถูกจัดเข้าค่าไฟประเภทที่ 3 (กิจการขนาดกลาง)`,
        `และต้องคุมให้ต่ำกว่า ${kw(cfg.demandLimitKw)} <b>ติดต่อกัน 12 เดือน</b> ถึงจะกลับมาประเภทที่ 2 ได้`,
        cfg.tierPenaltyPerMonth > 0 ? `💸 ส่วนต่างที่ประเมินไว้ ≈ ${baht(cfg.tierPenaltyPerMonth)}/เดือน` : '',
        '',
        `จากนี้ไป <b>ทุกเดือนต้องไม่เกิน</b> ไม่ใช่แค่เดือนนี้ — เริ่มนับหนึ่งใหม่ตั้งแต่เดือนหน้า`,
        `แนะนำให้ทบทวนว่าหน้าต่างที่ทำพีคเกิดจากอะไร แล้วกันไม่ให้ซ้ำ`,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        priority: 'high',
        toBoss: true,
        telegram: body,
        emailSubject: `🛑 ${cfg.siteName}: เดือนนี้พีคเกิน ${cfg.demandLimitKw} kW (${kw(h.peakKw)})`,
        emailHtml: htmlWrap(body, '#991b1b'),
      };
    }

    case 'shed': {
      const mode = event.dryRun ? '(ซ้อม ไม่ได้สั่งจริง) ' : '';
      const lines = event.changes.map((a) => `${a.to === 'off' ? '⛔' : '✅'} ${esc(a.name)} → <b>${a.to === 'off' ? 'ปิด' : 'เปิด'}</b> (${a.to === 'off' ? '−' : '+'}${round1(a.kw)} kW)`);
      const body = [
        `🤖 <b>${mode}ระบบสั่งจัดการโหลดอัตโนมัติ</b>`,
        `${site} • ${time} น.`,
        '',
        lines.join('\n'),
        '',
        `เหตุผล: คาดว่าหน้าต่าง 15 นาทีนี้จะจบที่ ${kw(event.window.projectedKw)} (เป้า ${kw(cfg.demandTargetKw)})`,
        `📅 พีคเดือนนี้ ${kw(event.headroom.livePeakKw)} / เพดาน ${kw(event.headroom.limitKw)}`,
        '',
        `<i>ระบบจะเปิดกลับให้เองเมื่อไฟลงมาต่ำกว่า ${kw(cfg.demandRestoreKw)} หรือครบ ${cfg.autoshedMaxOffMin} นาที</i>`,
        `<i>ถ้าต้องการเปิดกลับทันที พิมพ์ /restore</i>`,
      ].join('\n');
      return {
        priority: 'high',
        telegram: body,
        emailSubject: `🤖 ${cfg.siteName}: ระบบตัดโหลดอัตโนมัติ ${event.changes.filter((a) => a.to === 'off').length} โซน`,
        emailHtml: htmlWrap(body, '#7c3aed'),
      };
    }

    case 'restore': {
      const lines = event.changes.map((a) => `✅ ${esc(a.name)} → <b>เปิดกลับแล้ว</b> (+${round1(a.kw)} kW)`);
      const body = [`🟢 <b>เปิดอุปกรณ์กลับแล้ว</b>`, `${site} • ${time} น.`, '', lines.join('\n')].join('\n');
      return { priority: 'low', telegram: body, emailSubject: null, emailHtml: null };
    }

    case 'night': {
      const body = [
        `🌙 <b>กลางคืนแต่ยังใช้ไฟอยู่ ${kw(sample.grid)}</b>`,
        `${site} • ${time} น.`,
        '',
        `เกณฑ์กลางคืนที่ตั้งไว้คือ ${kw(cfg.nightIdleKw)} — น่าจะมีอุปกรณ์เปิดค้าง`,
        `ตอนนี้ไม่มีโซลาร์ช่วย ไฟที่ใช้คือค่าไฟเต็ม ๆ ≈ ${baht(sample.grid * cfg.tariffOffPeak * 8)} ถ้าค้างถึงเช้า`,
        '',
        'ฝากเวรกลางคืนเดินตรวจ: แอร์ / ไฟโรงงาน / ปั๊ม / คอมเพรสเซอร์',
      ].join('\n');
      return {
        priority: 'normal',
        telegram: body,
        emailSubject: `🌙 ${cfg.siteName}: มีอุปกรณ์เปิดค้างกลางคืน (${kw(sample.grid)})`,
        emailHtml: htmlWrap(body, '#1d4ed8'),
      };
    }

    case 'inverter': {
      const body = [
        `🛠 <b>โซลาร์ไม่ผลิตทั้งที่แดดควรแรง</b>`,
        `${site} • ${time} น.`,
        '',
        `โซลาร์ผลิตอยู่แค่ ${kw(sample.pv)} จากระบบขนาด ${cfg.systemKwp} kWp`,
        'เป็นไปได้ว่าอินเวอร์เตอร์ trip / เบรกเกอร์ตก / ระบบสื่อสารหลุด',
        '',
        'ให้ช่างซ่อมบำรุงเช็คอินเวอร์เตอร์และเบรกเกอร์ฝั่ง AC ครับ',
      ].join('\n');
      return {
        priority: 'high',
        telegram: body,
        emailSubject: `🛠 ${cfg.siteName}: โซลาร์ไม่ผลิต (${kw(sample.pv)}) — ตรวจอินเวอร์เตอร์`,
        emailHtml: htmlWrap(body, '#b45309'),
      };
    }

    default:
      return null;
  }
}

/** สรุปประจำวัน ส่งตอนเย็น */
export function buildDailySummary(state, cfg, now = Date.now(), headroom = null) {
  const s = state.samples || [];
  const day = s.filter((x) => x.t >= now - 20 * 60 * 60 * 1000);
  if (!day.length) return null;

  const hours = 5 / 60; // 1 ตัวอย่าง = 5 นาที
  const gridKwh = day.reduce((a, x) => a + Math.max(0, x.grid || 0) * hours, 0);
  const pvKwh = day.reduce((a, x) => a + Math.max(0, x.pv || 0) * hours, 0);
  const loadKwh = day.reduce((a, x) => a + Math.max(0, x.load || 0) * hours, 0);
  const coverage = loadKwh > 0 ? Math.round(((loadKwh - gridKwh) / loadKwh) * 100) : 0;
  const cost = gridKwh * cfg.tariffOnPeak;
  const saved = (loadKwh - gridKwh) * cfg.tariffOnPeak;
  const peak = state.peakToday || { kw: 0, at: 0 };

  const body = [
    `📊 <b>สรุปการใช้ไฟวันนี้ — ${esc(cfg.siteName)}</b>`,
    thDateThai(now),
    '',
    `☀️ โซลาร์ผลิต <b>${round1(pvKwh)} kWh</b>`,
    `🏭 ใช้ไฟรวม ${round1(loadKwh)} kWh`,
    `⚡ ซื้อจากการไฟฟ้า <b>${round1(gridKwh)} kWh</b> ≈ ${baht(cost)}`,
    `🔋 โซลาร์ครอบคลุม <b>${coverage}%</b> ของการใช้ไฟ`,
    `💚 ประหยัดได้วันนี้ ≈ <b>${baht(saved)}</b>`,
    '',
    `📈 ดึงไฟหลวงสูงสุด ${kw(peak.kw)} เวลา ${peak.at ? hhmm(peak.at) : '-'} น.`,
    ...(headroom
      ? [
          '',
          `<b>⚠️ เพดานการไฟฟ้า (สำคัญที่สุด)</b>`,
          `พีค 15 นาทีของวันนี้ ${kw(state.demand?.todayPeakKw || 0)}`,
          `พีคสะสมของเดือนนี้ <b>${kw(headroom.peakKw)}</b> / เพดาน ${kw(headroom.limitKw)}`,
          headroom.breached
            ? `🛑 เดือนนี้เกินเพดานไปแล้ว — เริ่มนับใหม่เดือนหน้า`
            : `📏 เหลือระยะปลอดภัยอีก <b>${kw(headroom.headroomKw)}</b> (ใช้ไป ${headroom.usedPct}% ของเพดาน)`,
        ]
      : []),
  ].join('\n');

  return {
    priority: 'low',
    telegram: body,
    emailSubject: `📊 สรุปการใช้ไฟ ${cfg.siteName} — ${thDateThai(now)}`,
    emailHtml: htmlWrap(body, '#059669'),
  };
}

/** แปลง HTML แบบ Telegram ให้เป็นอีเมลอ่านง่าย */
function htmlWrap(telegramHtml, color) {
  const body = telegramHtml.replace(/\n/g, '<br>');
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto">
  <div style="border-left:6px solid ${color};background:#f8fafc;padding:20px 22px;border-radius:8px;line-height:1.75;font-size:16px;color:#0f172a">
    ${body}
  </div>
  <p style="color:#64748b;font-size:12px;margin-top:16px">ส่งอัตโนมัติจากระบบเฝ้าระวังโซลาร์ • Solar Guard</p>
</div>`;
}

export { esc, kw, baht };
