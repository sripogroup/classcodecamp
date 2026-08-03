/**
 * หน้าวัดโหลดรายโซน — ใช้บนมือถือขณะเดินเปิด-ปิดเครื่องใช้ไฟฟ้าทีละตัว
 *
 * ออกแบบให้คนที่กำลังยืนอยู่หน้าเบรกเกอร์ใช้ได้ด้วยมือเดียว:
 *   ปุ่มใหญ่ ตัวเลขใหญ่ บอกชัดว่าตอนนี้ต้องทำอะไรและอีกกี่นาทีถึงจะพอ
 *   ไม่ต้องจำว่าโซนไหนต้องเปิดนานแค่ไหน หน้าจอนับถอยหลังให้เอง
 *
 * ทั้งหน้าอยู่ในไฟล์เดียว ไม่โหลดอะไรจากข้างนอก เหมือนหน้าจอหลัก
 */

export function zonesHtml(cfg) {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>วัดโหลดรายโซน — ${esc(cfg.siteName)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><text y='52' font-size='52'>⚡</text></svg>">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b1120;color:#e2e8f0;
       min-height:100vh;padding:16px;font-size:16px}
  .wrap{max-width:760px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  h1{font-size:19px;font-weight:700}
  h2{font-size:15px;color:#94a3b8;margin:26px 0 12px}
  a.back{color:#60a5fa;text-decoration:none;font-size:15px}
  .card{background:#111c33;border:1px solid #1e293b;border-radius:16px;padding:18px;margin-bottom:14px}
  .now{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;text-align:center}
  .now .l{font-size:13px;color:#94a3b8}
  .now .v{font-size:27px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:2px}
  .v.load{color:#60a5fa} .v.base{color:#94a3b8} .v.delta{color:#f59e0b}
  /* ---- กล่องที่กำลังวัด ---- */
  #live{border-color:#f59e0b;background:linear-gradient(160deg,#1c1408,#111c33)}
  #live.ready{border-color:#22c55e;background:linear-gradient(160deg,#062e1c,#111c33)}
  .lname{font-size:22px;font-weight:800;line-height:1.3}
  .ltimer{font-size:52px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1;margin:10px 0 4px}
  .lhint{font-size:16px;color:#fcd34d;line-height:1.55}
  #live.ready .lhint{color:#86efac}
  .prog{height:14px;background:#1e293b;border-radius:99px;overflow:hidden;margin:14px 0}
  .prog span{display:block;height:100%;background:#f59e0b;transition:width .5s}
  #live.ready .prog span{background:#22c55e}
  .lstats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px;text-align:center}
  .lstats .l{font-size:12px;color:#94a3b8}
  .lstats .v{font-size:21px;font-weight:700;font-variant-numeric:tabular-nums}
  /* ---- ปุ่ม ---- */
  button{font-family:inherit;font-size:17px;font-weight:600;border-radius:12px;padding:15px 18px;
         cursor:pointer;border:1px solid #334155;background:#1e293b;color:#e2e8f0;width:100%}
  button:active{transform:scale(.99)}
  button[disabled]{opacity:.45;cursor:not-allowed}
  .go{background:#f59e0b;color:#0b1120;border-color:#f59e0b}
  .stop{background:#22c55e;color:#052e16;border-color:#22c55e}
  .ghost{background:transparent;color:#94a3b8}
  .row{display:flex;gap:10px;margin-top:12px}
  /* ---- รายการโซน ---- */
  .zlist{display:grid;gap:10px}
  .z{background:#111c33;border:1px solid #1e293b;border-radius:14px;padding:14px 16px;
     display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .z.done{border-color:#166534}
  .z.fail{border-color:#b45309}
  .z.prot{border-color:#334155;opacity:.9}
  .z .info{flex:1;min-width:180px}
  .z .zn{font-size:17px;font-weight:700}
  .z .zs{font-size:13px;color:#64748b;margin-top:3px;line-height:1.5}
  .z .kw{font-size:25px;font-weight:800;font-variant-numeric:tabular-nums;color:#f59e0b;white-space:nowrap}
  .z .kw small{display:block;font-size:11px;color:#64748b;font-weight:600;text-align:right}
  .z button{width:auto;padding:11px 18px;font-size:15px}
  .badge{display:inline-block;font-size:11px;padding:3px 9px;border-radius:99px;margin-left:6px;vertical-align:middle}
  .badge.lock{background:#334155;color:#cbd5e1}
  .badge.ord{background:#422006;color:#fcd34d}
  .warn{color:#fca5a5;font-size:13px;margin-top:6px;line-height:1.5}
  table{width:100%;border-collapse:collapse}
  th{font-size:12px;color:#64748b;text-align:left;padding:0 8px 8px 0;border-bottom:1px solid #1e293b;font-weight:600}
  td{padding:11px 8px 11px 0;border-bottom:1px solid #1e293b40;font-size:16px;color:#cbd5e1}
  td.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:#f8fafc;white-space:nowrap}
  .muted{color:#64748b;font-size:14px;line-height:1.7}
  .err{background:#7f1d1d55;border:1px solid #ef444488;color:#fca5a5;padding:12px 14px;border-radius:10px;margin-bottom:12px}
  .ok{background:#06402855;border:1px solid #22c55e88;color:#86efac;padding:12px 14px;border-radius:10px;margin-bottom:12px}
  select,input[type=text],input[type=number],input:not([type]){font-family:inherit;font-size:16px;padding:13px;
         border-radius:12px;background:#0b1120;color:#f8fafc;border:1px solid #334155;width:100%}
  input:focus,select:focus{outline:none;border-color:#f59e0b}
  .fl{display:block;font-size:13px;color:#94a3b8;margin:14px 0 6px}
  .frow{display:flex;gap:12px;flex-wrap:wrap}
  .chk{display:flex;align-items:center;gap:10px;margin-top:14px;font-size:15px;color:#cbd5e1;line-height:1.45}
  .chk input{width:22px;height:22px;flex:none;accent-color:#f59e0b}
  .tools{display:flex;gap:6px;margin-left:auto}
  .tools button{width:auto;padding:8px 11px;font-size:14px;background:transparent;color:#94a3b8}
  .shedrow-tools button{width:auto;padding:6px 10px;font-size:15px;background:#1e293b;color:#cbd5e1;margin-left:4px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>⚡ วัดโหลดรายโซน</h1>
    <a class="back" href="/">← กลับหน้าจอหลัก</a>
  </header>

  <div id="msg"></div>

  <div class="card">
    <div class="now">
      <div><div class="l">โหลดตอนนี้</div><div class="v load" id="nLoad">–</div></div>
      <div><div class="l">เส้นฐาน (ไฟส่องสว่าง)</div><div class="v base" id="nBase">–</div></div>
      <div><div class="l">ส่วนที่เกินฐาน</div><div class="v delta" id="nDelta">–</div></div>
    </div>
  </div>

  <div class="card" id="live" style="display:none">
    <div class="lname" id="lName">–</div>
    <div class="ltimer" id="lTimer">0:00</div>
    <div class="lhint" id="lHint">–</div>
    <div class="prog"><span id="lProg" style="width:0%"></span></div>
    <div class="lstats">
      <div><div class="l">ตอนนี้เพิ่มขึ้น</div><div class="v" id="lNow">–</div></div>
      <div><div class="l">สูงสุดที่เห็น</div><div class="v" id="lPeak">–</div></div>
      <div><div class="l">เก็บได้</div><div class="v" id="lSamples">–</div></div>
    </div>
    <div class="row">
      <button class="stop" id="btnStop">จบการวัด แล้วปิดโซนนี้</button>
      <button class="ghost" id="btnCancel" style="max-width:120px">ทิ้ง</button>
    </div>
  </div>

  <div class="card" id="starter">
    <div class="muted" id="nextHint" style="margin-bottom:10px"></div>
    <select id="pick"></select>
    <label class="chk"><input type="checkbox" id="fPre"> เครื่องนี้<b>เปิดค้างอยู่ก่อนแล้ว</b> (ไม่ได้เพิ่งเปิด)</label>
    <div class="row"><button class="go" id="btnStart">เริ่มวัดโซนนี้</button></div>
    <div class="muted" style="margin-top:10px" id="startHint"></div>
  </div>

  <h2>ผลที่วัดได้แล้ว</h2>
  <div class="zlist" id="zlist"></div>

  <h2>ลำดับที่ระบบจะสั่งให้ปิดเวลาไฟเกิน</h2>
  <div class="card">
    <table id="shed"><tbody></tbody></table>
    <div class="muted" id="shedNote" style="margin-top:12px"></div>
  </div>

  <h2>เพิ่ม / แก้โซน</h2>
  <div class="card">
    <div class="muted" style="margin-bottom:12px" id="formHint">
      ซื้อแอร์เพิ่ม ติดปั๊มใหม่ ตั้งตู้แช่ — เพิ่มเข้ารายการได้เลย แล้วค่อยไปวัดทีหลัง
    </div>
    <label class="fl">ชื่อโซน</label>
    <input id="fName" placeholder="เช่น แอร์ห้องประชุม, ตู้แช่หน้าร้าน">
    <div class="frow">
      <div style="flex:1">
        <label class="fl">ต้องเปิดค้างกี่นาทีตอนวัด</label>
        <input id="fMin" type="number" min="1" max="120" value="15" inputmode="numeric">
      </div>
      <div style="flex:1">
        <label class="fl">ใครดูแล (ไม่ใส่ก็ได้)</label>
        <input id="fOwner" placeholder="เช่น พนักงานโกดัง">
      </div>
    </div>
    <label class="fl">หมายเหตุ (ไม่ใส่ก็ได้)</label>
    <input id="fNote" placeholder="เช่น ปิดได้เฉพาะตอนไม่มีประชุม">
    <label class="chk"><input type="checkbox" id="fProt"> ห้ามสั่งปิดเด็ดขาด (เช่น ไฟส่องสว่าง ตู้แช่ที่ของจะเสีย)</label>
    <label class="chk"><input type="checkbox" id="fBase"> เป็นโหลดพื้นฐาน เปิดค้างตลอด (ใช้เป็นเส้นฐานให้โซนอื่น)</label>
    <div class="row">
      <button class="go" id="btnSaveZone">เพิ่มโซน</button>
      <button class="ghost" id="btnResetForm" style="max-width:110px;display:none">ยกเลิก</button>
    </div>
    <div id="removed" class="muted" style="margin-top:16px"></div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let DATA = null, tick = null;

const kw = (v) => (v === null || v === undefined ? '–' : v.toFixed(1) + ' kW');
const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

function msg(text, kind) {
  $('msg').innerHTML = text ? '<div class="' + (kind || 'ok') + '">' + text + '</div>' : '';
  if (text) setTimeout(() => { if ($('msg').textContent === text) $('msg').innerHTML = ''; }, 9000);
}

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const out = await res.json().catch(() => ({ ok: false, error: 'ตอบกลับมาไม่ใช่ JSON' }));
  if (!res.ok || out.ok === false) throw new Error(out.error || ('HTTP ' + res.status));
  return out;
}

async function load() {
  try {
    const [z, s] = await Promise.all([api('/api/loads'), api('/api/state')]);
    DATA = z; DATA.state = s;
    render();
  } catch (e) { msg('โหลดข้อมูลไม่ได้: ' + e.message, 'err'); }
}

function render() {
  const d = DATA;
  const loadKw = d.state?.loadKw ?? null;
  $('nLoad').textContent = kw(loadKw);
  $('nBase').textContent = kw(d.baselineKw);
  $('nDelta').textContent = (loadKw !== null && d.baselineKw !== null) ? kw(Math.max(0, loadKw - d.baselineKw)) : '–';

  // ---- กล่องกำลังวัด ----
  const r = d.running;
  $('live').style.display = r ? 'block' : 'none';
  $('starter').style.display = r ? 'none' : 'block';
  if (r) {
    $('lName').textContent = r.name;
    const live = r.live || {};
    $('lNow').textContent = kw(live.steadyKw);
    $('lPeak').textContent = kw(live.peakKw);
    $('lSamples').textContent = (live.samples || 0) + ' จุด';
  }

  // ---- รายการโซน ----
  $('zlist').innerHTML = d.zones.map((z) => {
    const m = z.measured;
    const f = z.failed;
    const cls = 'z' + (m ? ' done' : '') + (f ? ' fail' : '') + (z.protectedZone ? ' prot' : '');
    const sub = [];
    if (z.protectedZone) sub.push('ปิดไม่ได้');
    else if (z.shedOrder) sub.push('ปิดเป็นลำดับที่ ' + z.shedOrder);
    sub.push('ต้องเปิดค้าง ' + z.minutes + ' นาที');
    if (m) sub.push('วัดเมื่อ ' + when(m.at));
    else if (f) sub.push('ลองวัดเมื่อ ' + when(f.at) + ' แต่ใช้ไม่ได้');
    if (z.note) sub.push(z.note);
    const wsrc = m || f;
    const warn = wsrc && wsrc.warnings && wsrc.warnings.length
      ? '<div class="warn">⚠ ' + wsrc.warnings.join('<br>⚠ ') + '</div>' : '';
    const val = m
      ? '<div class="kw">' + m.steadyKw.toFixed(1) + '<small>เดินปกติ (พีค ' + m.peakKw.toFixed(1) + ')</small></div>'
      : '';
    const btn = d.running ? '' :
      '<button' + (f && !m ? ' class="go"' : '') + ' data-go="' + z.slug + '">' +
      (m ? 'วัดใหม่' : f ? 'วัดอีกครั้ง' : 'วัด') + '</button>';
    // ผลที่ระบบไม่รับ แต่คนอาจรู้ว่าถูกอยู่แล้ว (เช่นเปิดค้างมาทั้งวัน โหลดนิ่งแล้ว)
    const okBtn = f && f.steadyKw > 0
      ? '<button class="stop" data-ok="' + f.id + '" style="width:auto;padding:10px 14px;font-size:14px">ใช้ค่า ' + f.steadyKw.toFixed(1) + ' kW นี้</button>'
      : '';
    const tools = d.running ? '' :
      '<span class="tools"><button data-edit="' + z.slug + '" title="แก้">✏️</button>' +
      '<button data-del="' + z.slug + '" title="เอาออกจากรายการ">🗑</button></span>';
    return '<div class="' + cls + '"><div class="info"><div class="zn">' + z.name +
      (z.protectedZone ? '<span class="badge lock">🔒 ห้ามปิด</span>' : '') +
      '</div><div class="zs">' + sub.join(' · ') + '</div>' + warn + '</div>' + val + okBtn + btn + tools + '</div>';
  }).join('');

  document.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => start(b.dataset.go); });
  document.querySelectorAll('[data-ok]').forEach((b) => {
    b.onclick = async () => {
      try {
        const out = await api('/api/loads/confirm', { id: Number(b.dataset.ok) });
        msg('รับค่าแล้ว: <b>' + out.result.name + '</b> = ' + out.result.steadyKw.toFixed(1) + ' kW');
        await load();
      } catch (e) { msg(e.message, 'err'); }
    };
  });
  document.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => editZone(b.dataset.edit); });
  document.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => removeZone(b.dataset.del); });

  // ---- ตัวเลือกโซนถัดไป ----
  $('pick').innerHTML = d.zones.map((z) =>
    '<option value="' + z.slug + '"' + (d.nextSuggestion && d.nextSuggestion.slug === z.slug ? ' selected' : '') + '>' +
    z.name + ' — เปิดค้าง ' + z.minutes + ' นาที' + (z.measured ? ' (วัดแล้ว)' : '') + '</option>').join('');
  $('nextHint').textContent = d.nextSuggestion
    ? 'วัดแล้ว ' + d.doneCount + ' จาก ' + d.totalCount + ' โซน — ถัดไปที่แนะนำ: ' + d.nextSuggestion.name
    : 'วัดครบทุกโซนแล้ว ' + d.doneCount + '/' + d.totalCount;

  // ---- ลำดับการปิด (เลื่อนขึ้น/ลงได้) ----
  const rows = d.shedList.map((s, i) =>
    '<tr><td>' + (i + 1) + '. ' + s.name + (s.owner ? ' <span class="muted">— ' + s.owner + '</span>' : '') +
    '</td><td class="n">−' + s.kw.toFixed(1) + ' kW</td>' +
    '<td class="n shedrow-tools" style="width:1%">' +
    (i > 0 ? '<button data-mv="up" data-slug="' + s.slug + '" title="ปิดก่อนขึ้นอีกขั้น">↑</button>' : '') +
    (i < d.shedList.length - 1 ? '<button data-mv="down" data-slug="' + s.slug + '" title="ปิดทีหลังลงอีกขั้น">↓</button>' : '') +
    '</td></tr>').join('');
  $('shed').querySelector('tbody').innerHTML = rows ||
    '<tr><td class="muted">ยังไม่มีข้อมูล — วัดอย่างน้อยหนึ่งโซนก่อน</td></tr>';
  // ---- โซนที่เอาออกไป (ยังกู้กลับได้) ----
  const rm = d.removedZones || [];
  $('removed').innerHTML = rm.length
    ? 'เอาออกไปแล้ว: ' + rm.map((z) =>
        z.name + ' <button data-restore="' + z.slug + '" style="width:auto;padding:5px 10px;font-size:13px">เอากลับมา</button>').join(' · ')
    : '';
  document.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      try { await api('/api/loads/zone/restore', { slug: b.dataset.restore }); await load(); msg('เอากลับมาแล้ว'); }
      catch (e) { msg(e.message, 'err'); }
    };
  });

  document.querySelectorAll('[data-mv]').forEach((b) => {
    b.onclick = async () => {
      try { await api('/api/loads/zone/move', { slug: b.dataset.slug, dir: b.dataset.mv }); await load(); }
      catch (e) { msg(e.message, 'err'); }
    };
  });

  $('shedNote').innerHTML = d.shedList.length
    ? 'ปิดครบทั้งหมดนี้ลดได้ <b>' + d.totalShedableKw.toFixed(1) + ' kW</b> — ' +
      'เวลาไฟเกิน ระบบจะเลือกจากบนลงล่างให้พอดีกับส่วนที่เกิน แล้วส่งเข้า Telegram / LINE / อีเมล ' +
      'ไฟส่องสว่างไม่อยู่ในรายการนี้เพราะสั่งปิดไม่ได้'
    : 'เวลาไฟเกินตอนนี้ ระบบยังใช้รายการตัวอย่างที่เดาไว้ในโค้ด ซึ่งไม่ตรงกับของจริง';
}

function when(ts) {
  const d = new Date(ts + 7 * 3600000);
  return d.getUTCDate() + '/' + (d.getUTCMonth() + 1) + ' ' +
    String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

/* ---- ฟอร์มเพิ่ม/แก้โซน ---- */
let editing = null;

function fillForm(z) {
  editing = z ? z.slug : null;
  $('fName').value = z ? z.name : '';
  $('fMin').value = z ? z.minutes : 15;
  $('fOwner').value = z && z.owner ? z.owner : '';
  $('fNote').value = z && z.note ? z.note : '';
  $('fProt').checked = !!(z && z.protectedZone);
  $('fBase').checked = !!(z && z.baseline);
  $('btnSaveZone').textContent = z ? 'บันทึกการแก้ไข' : 'เพิ่มโซน';
  $('btnResetForm').style.display = z ? 'block' : 'none';
  $('formHint').textContent = z
    ? 'กำลังแก้ "' + z.name + '" — ผลวัดเก่ายังอยู่ครบ'
    : 'ซื้อแอร์เพิ่ม ติดปั๊มใหม่ ตั้งตู้แช่ — เพิ่มเข้ารายการได้เลย แล้วค่อยไปวัดทีหลัง';
}

function editZone(slug) {
  const z = DATA.zones.find((x) => x.slug === slug);
  if (!z) return;
  fillForm(z);
  $('fName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function removeZone(slug) {
  const z = DATA.zones.find((x) => x.slug === slug);
  if (!z) return;
  if (!confirm('เอา "' + z.name + '" ออกจากรายการ?\\n\\nผลที่วัดไว้ยังเก็บอยู่ในฐานข้อมูล เอากลับมาได้ภายหลัง')) return;
  try { await api('/api/loads/zone/remove', { slug: slug }); if (editing === slug) fillForm(null); await load(); msg('เอาออกแล้ว'); }
  catch (e) { msg(e.message, 'err'); }
}

$('btnResetForm').onclick = () => fillForm(null);

$('btnSaveZone').onclick = async () => {
  const body = {
    slug: editing || '',
    name: $('fName').value,
    minutes: Number($('fMin').value),
    owner: $('fOwner').value,
    note: $('fNote').value,
    protectedZone: $('fProt').checked,
    baseline: $('fBase').checked,
  };
  if (!body.name.trim()) { msg('ต้องใส่ชื่อโซนก่อน', 'err'); return; }
  try {
    const out = await api('/api/loads/zone', body);
    msg(editing ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่ม "' + out.zone.name + '" แล้ว — กดปุ่ม "วัด" ข้างชื่อได้เลยเมื่อพร้อม');
    fillForm(null);
    await load();
  } catch (e) { msg(e.message, 'err'); }
};

async function start(slug) {
  const pre = $('fPre').checked;
  try {
    await api('/api/loads/start', { zone: slug, preRunning: pre });
    msg(pre
      ? 'เริ่มแล้ว — เทียบกับเส้นฐานที่บันทึกไว้ ปล่อยไว้สัก 2-3 นาทีแล้วกดจบได้เลย'
      : 'เริ่มจับเวลาแล้ว — เปิดค้างไว้จนกว่าหน้าจอจะเป็นสีเขียว');
    await load();
  } catch (e) { msg(e.message, 'err'); }
}

$('btnStart').onclick = () => start($('pick').value);

/* คำอธิบายเปลี่ยนตามช่องติ๊ก เพราะสองแบบนี้เทียบเส้นฐานคนละที่ ผลจึงต่างกันมาก */
function paintStartHint() {
  const pre = $('fPre').checked;
  $('startHint').innerHTML = pre
    ? 'เทียบกับ<b>เส้นฐานที่บันทึกไว้</b> (ไฟส่องสว่าง ' + (DATA && DATA.baselineKw !== null ? DATA.baselineKw.toFixed(1) + ' kW' : 'ยังไม่ได้วัด') + ') ' +
      'ใช้เมื่อของเปิดค้างมานานแล้ว — ไม่ต้องรอครบเวลา เพราะไม่มีช่วงกินไฟสูงตอนสตาร์ทให้รอ'
    : 'กดตอนที่เพิ่งเปิดเครื่องเสร็จ ระบบจะเทียบกับ 90 วินาทีก่อนหน้าเป็นเส้นฐานให้เอง';
}
$('fPre').onchange = paintStartHint;
paintStartHint();

$('btnCancel').onclick = async () => {
  if (!confirm('ทิ้งการวัดนี้ ไม่เก็บผล?')) return;
  try { await api('/api/loads/cancel', {}); await load(); msg('ทิ้งแล้ว'); }
  catch (e) { msg(e.message, 'err'); }
};

$('btnStop').onclick = async () => {
  const r = DATA?.running;
  const need = (r?.minutes || 15) * 60;
  const el = (Date.now() - (r?.startedAt || 0)) / 1000;
  if (el < need && !confirm('ยังเปิดไม่ครบ ' + r.minutes + ' นาที ค่าที่ได้จะสูงกว่าจริง จบเลยไหม?')) return;
  try {
    const out = await api('/api/loads/stop', {});
    const x = out.result;
    msg('บันทึกแล้ว: <b>' + x.name + '</b> กินไฟ <b>' + x.steadyKw.toFixed(1) + ' kW</b> ' +
        '(พีคตอนสตาร์ท ' + x.peakKw.toFixed(1) + ' kW) — ปิดโซนนี้ได้เลย ' +
        'รอโหลดนิ่งสัก 2 นาทีแล้วค่อยเปิดโซนถัดไป' +
        (x.warnings.length ? '<br>⚠ ' + x.warnings.join('<br>⚠ ') : ''));
    await load();
  } catch (e) { msg(e.message, 'err'); }
};

// นับเวลาเดินหน้าทุกวินาที (ไม่ต้องรอรอบดึงข้อมูล จะได้ไม่กระตุก)
setInterval(() => {
  const r = DATA?.running;
  if (!r) return;
  const el = (Date.now() - r.startedAt) / 1000;
  const need = r.minutes * 60;
  const done = el >= need;
  $('lTimer').textContent = mmss(el);
  $('lProg').style.width = Math.min(100, (el / need) * 100) + '%';
  $('live').className = 'card' + (done ? ' ready' : '');
  $('lHint').innerHTML = done
    ? '✅ ครบเวลาแล้ว — กดปุ่มข้างล่างเพื่อบันทึก แล้วปิดโซนนี้ได้เลย'
    : 'เปิดค้างไว้ก่อน อีก <b>' + mmss(need - el) + '</b> ('
      + r.minutes + ' นาที เพื่อให้ผ่านช่วงกินไฟสูงตอนเพิ่งเปิด แล้วเข้าสู่รอบเดินปกติ)';
}, 1000);

load();
setInterval(load, 10000);
</script>
</body>
</html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
