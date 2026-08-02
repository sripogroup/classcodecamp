/**
 * หน้าจอติดผนัง (เอาแท็บเล็ตเก่า/คอมเครื่องไหนก็ได้ เปิดค้างไว้หน้าออฟฟิศ)
 *
 * - ไฟสามสี เขียว/เหลือง/แดง เห็นจากไกล ๆ ไม่ต้องอ่านตัวเลข
 * - มีเสียงไซเรนจากลำโพงเครื่องนั้นเลย (ยังไม่ต้องซื้อไฟหมุน)
 * - กราฟวันนี้ ดูได้ว่าช่วงไหนไฟหลวงเข้าเยอะ
 * ทั้งหน้าอยู่ในไฟล์เดียว ไม่โหลดอะไรจากข้างนอก เปิดในโรงงานที่เน็ตช้าก็ยังขึ้น
 */

export function dashboardHtml(cfg, token) {
  const q = token ? `?k=${encodeURIComponent(token)}` : '';
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>เฝ้าระวังการใช้ไฟ — ${escapeHtml(cfg.siteName)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b1120;color:#e2e8f0;min-height:100vh;padding:24px}
  .wrap{max-width:1100px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:24px}
  h1{font-size:20px;font-weight:600;color:#94a3b8}
  .clock{font-size:20px;color:#64748b;font-variant-numeric:tabular-nums}
  .status{border-radius:20px;padding:32px;display:flex;align-items:center;gap:28px;flex-wrap:wrap;transition:background .4s}
  .status.green{background:linear-gradient(135deg,#064e3b,#065f46)}
  .status.yellow{background:linear-gradient(135deg,#78350f,#92400e)}
  .status.red{background:linear-gradient(135deg,#7f1d1d,#991b1b);animation:pulse 1.4s infinite}
  .status.stale{background:linear-gradient(135deg,#334155,#1e293b)}
  @keyframes pulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.45)}}
  .lamp{width:104px;height:104px;border-radius:50%;flex:none;box-shadow:0 0 60px currentColor}
  .green .lamp{background:#22c55e;color:#22c55e}
  .yellow .lamp{background:#f59e0b;color:#f59e0b}
  .red .lamp{background:#ef4444;color:#ef4444}
  .stale .lamp{background:#64748b;color:#64748b}
  .headline{font-size:34px;font-weight:800;line-height:1.25}
  .sub{font-size:17px;color:#e2e8f0cc;margin-top:8px;line-height:1.6}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px;margin-top:20px}
  .card{background:#111c33;border:1px solid #1e293b;border-radius:16px;padding:20px}
  .label{font-size:14px;color:#94a3b8;margin-bottom:8px}
  .value{font-size:36px;font-weight:700;font-variant-numeric:tabular-nums}
  .unit{font-size:17px;color:#94a3b8;font-weight:500;margin-left:4px}
  .bar{height:12px;background:#1e293b;border-radius:99px;overflow:hidden;margin-top:14px}
  .bar span{display:block;height:100%;background:linear-gradient(90deg,#f59e0b,#22c55e);transition:width .5s}
  .actions{margin-top:20px;background:#111c33;border:1px solid #1e293b;border-radius:16px;padding:20px}
  .actions h2{font-size:16px;color:#f8fafc;margin-bottom:14px}
  .actions ol{padding-left:22px;line-height:2;color:#cbd5e1;font-size:17px}
  .actions b{color:#fca5a5}
  canvas{width:100%;height:190px;display:block;margin-top:12px}
  footer{margin-top:24px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;color:#64748b;font-size:13px}
  button{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:10px;padding:10px 18px;font-size:15px;cursor:pointer;font-family:inherit}
  button.on{background:#166534;border-color:#22c55e;color:#dcfce7}
  .legend{display:flex;gap:16px;font-size:13px;color:#94a3b8;margin-top:8px}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>⚡ เฝ้าระวังการใช้ไฟ — ${escapeHtml(cfg.siteName)}</h1>
    <div class="clock" id="clock">--:--</div>
  </header>

  <div class="status stale" id="status">
    <div class="lamp"></div>
    <div>
      <div class="headline" id="headline">กำลังโหลดข้อมูล…</div>
      <div class="sub" id="subline">เชื่อมต่อกับ FusionSolar</div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">ดึงไฟจากการไฟฟ้า</div>
      <div class="value" id="grid">–<span class="unit">kW</span></div>
      <div class="label" style="margin-top:10px" id="thresholds"></div>
    </div>
    <div class="card">
      <div class="label">โซลาร์ผลิตอยู่</div>
      <div class="value" id="pv">–<span class="unit">kW</span></div>
      <div class="label" style="margin-top:10px" id="daypv"></div>
    </div>
    <div class="card">
      <div class="label">โหลดรวมทั้งโรงงาน</div>
      <div class="value" id="load">–<span class="unit">kW</span></div>
      <div class="label" style="margin-top:10px" id="peak"></div>
    </div>
    <div class="card">
      <div class="label">โซลาร์ครอบคลุมโหลด</div>
      <div class="value" id="cov">–<span class="unit">%</span></div>
      <div class="bar"><span id="covbar" style="width:0%"></span></div>
    </div>
  </div>

  <div class="actions" id="actionsCard" style="display:none">
    <h2>✅ ให้ทำตามลำดับนี้</h2>
    <ol id="actionList"></ol>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="label">วันนี้ (ตั้งแต่เช้า)</div>
    <canvas id="chart"></canvas>
    <div class="legend">
      <span><i class="dot" style="background:#f59e0b"></i>ไฟจากการไฟฟ้า</span>
      <span><i class="dot" style="background:#22c55e"></i>โซลาร์</span>
      <span><i class="dot" style="background:#60a5fa"></i>โหลดรวม</span>
    </div>
  </div>

  <footer>
    <span id="updated">—</span>
    <button id="soundBtn">🔇 เปิดเสียงเตือน</button>
  </footer>
</div>

<script>
const TOKEN = ${JSON.stringify(q)};
let soundOn = localStorage.getItem('solarSound') === '1';
let audioCtx = null, sirenTimer = null, lastLevel = 'green';

const btn = document.getElementById('soundBtn');
function paintBtn(){ btn.textContent = soundOn ? '🔊 เสียงเตือนเปิดอยู่' : '🔇 เปิดเสียงเตือน'; btn.className = soundOn ? 'on' : ''; }
btn.onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem('solarSound', soundOn ? '1' : '0');
  paintBtn();
  if (soundOn) { ensureAudio(); beep(880, 0.15); } else stopSiren();
};
paintBtn();

function ensureAudio(){ if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)(); if(audioCtx.state==='suspended') audioCtx.resume(); }
function beep(freq, dur){
  if(!soundOn) return; ensureAudio();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type='square'; o.frequency.value=freq; o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime+0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime+dur);
  o.start(); o.stop(audioCtx.currentTime+dur+0.02);
}
/* ไซเรนกวาดความถี่ขึ้นลง เหมือนไซเรนจริง */
function siren(){
  if(!soundOn) return; ensureAudio();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
  o.type='sawtooth'; o.connect(g); g.connect(audioCtx.destination);
  o.frequency.setValueAtTime(520, t);
  o.frequency.linearRampToValueAtTime(1040, t+0.5);
  o.frequency.linearRampToValueAtTime(520, t+1.0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t+0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t+1.0);
  o.start(t); o.stop(t+1.05);
}
function startSiren(){ if(sirenTimer) return; siren(); sirenTimer = setInterval(siren, 4000); }
function stopSiren(){ if(sirenTimer){ clearInterval(sirenTimer); sirenTimer=null; } }

const HEADLINES = {
  green: ['🟢 ปกติ — โซลาร์รับไหว', 'ใช้ไฟได้ตามปกติ'],
  yellow:['🟡 เริ่มดึงไฟหลวงเยอะ', 'เตรียมลดการใช้ไฟ ถ้าปิดอะไรได้ให้ปิดก่อน'],
  red:   ['🔴 ลดการใช้ไฟตอนนี้', 'ไฟจากการไฟฟ้าเข้าหนัก ให้ปิดอุปกรณ์ตามรายการด้านล่างทันที'],
  stale: ['⚪ ไม่ได้รับข้อมูล', 'ระบบยังติดต่อ FusionSolar ไม่ได้ ให้แจ้งฝ่ายไอที']
};

function fmt(n, d){ return n===null||n===undefined ? '–' : Number(n).toFixed(d===undefined?1:d); }

async function tick(){
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'}) + ' น.';
  try{
    const [st, hist] = await Promise.all([
      fetch('/api/state'+TOKEN).then(r=>r.json()),
      fetch('/api/history'+TOKEN).then(r=>r.json())
    ]);
    render(st, hist.samples||[]);
  }catch(e){ /* เน็ตสะดุด รอบหน้าค่อยลองใหม่ */ }
}

function render(st, samples){
  const level = st.stale ? 'stale' : (st.level||'green');
  const box = document.getElementById('status');
  box.className = 'status ' + level;
  document.getElementById('headline').textContent = HEADLINES[level][0];
  document.getElementById('subline').textContent  = st.cause && level!=='green' && level!=='stale'
      ? HEADLINES[level][1] + ' — ' + st.cause : HEADLINES[level][1];

  document.getElementById('grid').innerHTML = fmt(st.gridImportKw) + '<span class="unit">kW</span>';
  document.getElementById('pv').innerHTML   = fmt(st.pvKw) + '<span class="unit">kW</span>';
  document.getElementById('load').innerHTML = fmt(st.loadKw) + '<span class="unit">kW</span>';
  const cov = st.coveragePct==null ? 0 : st.coveragePct;
  document.getElementById('cov').innerHTML  = fmt(cov,0) + '<span class="unit">%</span>';
  document.getElementById('covbar').style.width = Math.max(0,Math.min(100,cov)) + '%';
  document.getElementById('thresholds').textContent = 'เกณฑ์: เหลือง ' + st.warnKw + ' / แดง ' + st.critKw + ' kW';
  document.getElementById('daypv').textContent = st.dayPvKwh ? 'วันนี้ผลิตแล้ว ' + fmt(st.dayPvKwh,0) + ' kWh' : '';
  document.getElementById('peak').textContent = st.peakToday ? 'ดึงไฟหลวงสูงสุดวันนี้ ' + fmt(st.peakToday.kw) + ' kW' : '';
  document.getElementById('updated').textContent = st.updatedAt
    ? 'อัปเดตล่าสุด ' + new Date(st.updatedAt).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'}) + ' น.'
    : 'ยังไม่มีข้อมูล';

  const card = document.getElementById('actionsCard'), list = document.getElementById('actionList');
  if(st.actions && st.actions.length && level!=='green' && level!=='stale'){
    list.innerHTML = st.actions.map(a =>
      '<li>'+escapeHtml(a.name)+' <b>(−'+a.kw+' kW)</b>'+(a.owner?' — '+escapeHtml(a.owner):'')+'</li>').join('');
    card.style.display='block';
  } else card.style.display='none';

  if(level==='red') startSiren(); else stopSiren();
  if(level!=='red' && lastLevel==='red') beep(660,0.25);
  lastLevel = level;
  drawChart(samples);
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function drawChart(samples){
  const c = document.getElementById('chart'), ctx = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = 190 * devicePixelRatio;
  ctx.clearRect(0,0,w,h);
  if(samples.length < 2) return;
  const max = Math.max(10, ...samples.map(s=>Math.max(s.pv||0, s.load||0, s.grid||0))) * 1.15;
  const x = i => (i/(samples.length-1))*w;
  const y = v => h - (Math.max(0,v)/max)*(h-10) - 5;

  ctx.strokeStyle='#1e293b'; ctx.lineWidth=devicePixelRatio;
  for(let i=1;i<4;i++){ const gy=(h/4)*i; ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(w,gy); ctx.stroke(); }

  const line = (key,color) => {
    ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=2.5*devicePixelRatio; ctx.lineJoin='round';
    samples.forEach((s,i)=> i? ctx.lineTo(x(i), y(s[key])) : ctx.moveTo(x(i), y(s[key])));
    ctx.stroke();
  };
  line('load','#60a5fa'); line('pv','#22c55e'); line('grid','#f59e0b');
}

tick();
setInterval(tick, 60000);
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
