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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='14' fill='%23E53935'/><g stroke='%23E53935' stroke-width='5' stroke-linecap='round'><line x1='32' y1='4' x2='32' y2='14'/><line x1='32' y1='50' x2='32' y2='60'/><line x1='4' y1='32' x2='14' y2='32'/><line x1='50' y1='32' x2='60' y2='32'/><line x1='12' y1='12' x2='19' y2='19'/><line x1='45' y1='45' x2='52' y2='52'/><line x1='12' y1='52' x2='19' y2='45'/><line x1='45' y1='19' x2='52' y2='12'/></g></svg>">
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
  .bar.big{height:20px}
  .bar.big span{background:linear-gradient(90deg,#22c55e,#84cc16,#f59e0b,#ef4444);transition:width .5s}
  .ceiling{margin-top:20px;border-color:#334155}
  .ceiling.warn{border-color:#f59e0b;box-shadow:0 0 0 1px #f59e0b55}
  .ceiling.danger{border-color:#ef4444;box-shadow:0 0 0 1px #ef444455}
  .ceiling-top{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}
  .ceiling-val{font-size:44px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
  .ceiling-val .of{font-size:20px;color:#64748b;font-weight:600;margin-left:10px}
  .headroom{text-align:right}
  .headroom .ceiling-val{color:#22c55e}
  .headroom.low .ceiling-val{color:#f59e0b}
  .headroom.none .ceiling-val{color:#ef4444}
  #winCard{margin-top:16px}
  .winrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-top:12px}
  .wv{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:4px}
  .wv.alarm{color:#ef4444}
  /* ---- แผนภาพไฟวิ่ง ---- */
  #flowCard{margin-top:16px}
  #flowSvg{width:100%;height:auto;max-height:300px;display:block}
  .fnode{fill:#0e1a2f;stroke:#334155;stroke-width:1.5}
  .fnode.act{stroke:#475569}
  .ficon{font-size:30px;dominant-baseline:central;text-anchor:middle}
  .fname{fill:#94a3b8;font-size:12px;text-anchor:middle}
  .fval{font-size:20px;font-weight:800;text-anchor:middle;font-variant-numeric:tabular-nums}
  .fval.grid{fill:#f59e0b} .fval.pv{fill:#22c55e} .fval.load{fill:#60a5fa}
  /* เส้นฐานจาง ๆ ให้เห็นโครงตลอด แม้สายนั้นไม่มีไฟวิ่ง */
  .fpipe{fill:none;stroke:#1e293b;stroke-width:5;stroke-linecap:round}
  /* เส้นประที่เลื่อนไปเรื่อย ๆ = ไฟกำลังวิ่ง ทิศทางกลับได้ด้วย animation-direction */
  .fflow{fill:none;stroke-width:5;stroke-linecap:round;stroke-dasharray:2 16;
         animation:march 2s linear infinite;opacity:0}
  @keyframes march{to{stroke-dashoffset:-72}}
  .fflow.on{opacity:1}
  .fflow.rev{animation-direction:reverse}
  .fflow.g{stroke:#f59e0b} .fflow.p{stroke:#22c55e}
  @media (prefers-reduced-motion:reduce){ .fflow{animation:none} }
  #monthCard{margin-top:16px}
  #billCard{margin-top:16px}
  .billtop{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;margin-top:6px}
  .bigbaht{font-size:38px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.15;color:#f8fafc}
  .bigbaht .cur{font-size:19px;color:#94a3b8;font-weight:600;margin-left:6px}
  .bigbaht.month{color:#f59e0b}
  .brk{width:100%;border-collapse:collapse;margin-top:16px}
  .brk td{padding:9px 0;border-bottom:1px solid #1e293b26;font-size:15px;color:#94a3b8}
  .brk td:last-child{text-align:right;font-variant-numeric:tabular-nums;color:#cbd5e1;font-size:16px;white-space:nowrap}
  .brk tr.sum td{border-top:1px solid #334155;border-bottom:none;padding-top:12px;color:#f8fafc;font-weight:700;font-size:18px}
  .brk tr.sum td:last-child{color:#f59e0b;font-size:20px}
  .brk small{color:#64748b;font-size:12px}
  .peaks{width:100%;border-collapse:collapse;margin-top:12px}
  .peaks th{font-size:13px;color:#64748b;font-weight:600;text-align:left;padding:0 10px 8px 0;border-bottom:1px solid #1e293b}
  .peaks th:nth-child(2),.peaks td:nth-child(2){text-align:right;white-space:nowrap}
  .peaks th:nth-child(3),.peaks td:nth-child(3){text-align:right;white-space:nowrap}
  .peaks td{padding:11px 10px 11px 0;border-bottom:1px solid #1e293b26;font-size:17px;color:#cbd5e1}
  .peaks td:nth-child(2){font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:#f8fafc}
  .peaks td:nth-child(3){font-size:15px;color:#94a3b8;font-variant-numeric:tabular-nums}
  .peaks small{display:block;font-size:12px;color:#64748b;margin-top:3px}
  /* แถวแรกคือตัวที่การไฟฟ้าใช้คิดเงิน ต้องเด่นกว่าแถวอื่นชัด ๆ */
  .peaks tr.hi td{color:#f8fafc}
  .peaks tr.hi td:nth-child(2){color:#f59e0b;font-size:26px}
  .actions{margin-top:20px;background:#111c33;border:1px solid #1e293b;border-radius:16px;padding:20px}
  .actions h2{font-size:16px;color:#f8fafc;margin-bottom:14px}
  .actions ol{padding-left:22px;line-height:2;color:#cbd5e1;font-size:17px}
  .actions b{color:#fca5a5}
  canvas{width:100%;height:230px;display:block;margin-top:12px}
  footer{margin-top:24px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;color:#64748b;font-size:13px}
  button{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:10px;padding:10px 18px;font-size:15px;cursor:pointer;font-family:inherit}
  button.on{background:#166534;border-color:#22c55e;color:#dcfce7}
  .legend{display:flex;gap:16px;font-size:13px;color:#94a3b8;margin-top:8px}
  /* แถบเสียงบนสุด — เขียวเมื่อพร้อมส่งเสียง แดงกะพริบเมื่อเงียบอยู่ */
  .soundbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
            border-radius:14px;padding:12px 18px;margin-bottom:16px;font-size:16px;font-weight:600;
            background:#064e3b55;border:1px solid #22c55e66;color:#86efac}
  .soundbar.off{background:#7f1d1d55;border-color:#ef4444aa;color:#fca5a5;animation:pulse 1.6s infinite}
  .soundbar button{padding:9px 15px;font-size:14px}
  .navbtn{background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:10px;
          padding:10px 16px;font-size:15px;font-weight:600;text-decoration:none;white-space:nowrap}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>⚡ เฝ้าระวังการใช้ไฟ — ${escapeHtml(cfg.siteName)}</h1>
    <div style="display:flex;align-items:center;gap:14px">
      <a class="navbtn" href="/loads">🔌 โหลดรายโซน</a>
      <div class="clock" id="clock">--:--</div>
    </div>
  </header>

  <!-- แถบเสียงอยู่บนสุดโดยตั้งใจ: เสียงคือสิ่งเดียวที่เรียกคนได้ตอนไม่มีใครมองจอ
       ถ้าอยู่ท้ายหน้าแบบเดิม ต้องเลื่อนลงไปหาถึงจะรู้ว่ามันปิดอยู่ ซึ่งไม่มีใครทำ -->
  <div class="soundbar" id="soundBar">
    <span id="soundState">🔊 เสียงเตือนเปิดอยู่</span>
    <span style="display:flex;gap:10px;flex-wrap:wrap">
      <button id="soundBtn">ปิดเสียง</button>
      <button id="testBtn">🔔 ทดสอบเสียงไซเรน</button>
    </span>
  </div>

  <div class="status stale" id="status">
    <div class="lamp"></div>
    <div>
      <div class="headline" id="headline">กำลังโหลดข้อมูล…</div>
      <div class="sub" id="subline">เชื่อมต่อกับ FusionSolar</div>
      <div id="emgLine" style="display:none;margin-top:8px;font-size:20px;font-weight:800;color:#fecaca"></div>
    </div>
  </div>

  <div id="eveBanner" style="display:none;margin-top:16px;background:#f59e0b1a;border:1px solid #f59e0b66;border-radius:14px;padding:14px 18px;font-size:17px;line-height:1.55;color:#fcd34d"></div>

  <div class="card ceiling" id="ceilingCard">
    <div class="ceiling-top">
      <div>
        <div class="label">เพดานการไฟฟ้าเดือนนี้ (พีคเฉลี่ย 15 นาทีสูงสุด)</div>
        <div class="ceiling-val"><span id="mpeak">–</span><span class="unit">kW</span><span class="of">/ <span id="mlimit">30</span> kW</span></div>
      </div>
      <div class="headroom">
        <div class="label">เหลือระยะปลอดภัย</div>
        <div class="ceiling-val" id="mhead">–<span class="unit">kW</span></div>
      </div>
    </div>
    <div class="bar big"><span id="mbar" style="width:0%"></span></div>
    <div class="label" style="margin-top:10px" id="mnote">เกิน 30 kW แม้ครั้งเดียว = ค่าไฟประเภทที่ 3 นาน 12 เดือน</div>
  </div>

  <div class="card" id="winCard">
    <div class="label">หน้าต่าง 15 นาทีปัจจุบัน</div>
    <div class="winrow">
      <div><div class="label">ผ่านไป / เหลือ</div><div class="wv" id="wtime">– / –</div></div>
      <div><div class="label">เฉลี่ยไปแล้ว</div><div class="wv" id="wavg">–</div></div>
      <div><div class="label">คาดว่าจะจบที่</div><div class="wv" id="wproj">–</div></div>
      <div><div class="label">เวลาที่เหลือใช้ได้ไม่เกิน</div><div class="wv" id="wallow">–</div></div>
    </div>
  </div>

  <div class="card" id="flowCard">
    <div class="label">⚡ ไฟกำลังไหลอยู่ตอนนี้ <span id="flowAge" style="color:#64748b"></span></div>
    <svg id="flowSvg" viewBox="0 0 620 250" role="img" aria-label="แผนภาพการไหลของไฟ">
      <!-- เส้นฐาน: การไฟฟ้า -> โหลด, โซลาร์ -> โหลด, โซลาร์ -> การไฟฟ้า (ขายออก) -->
      <path id="pipeG" class="fpipe" d="M150 168 C 210 168, 240 140, 268 106"/>
      <path id="pipeP" class="fpipe" d="M470 168 C 410 168, 380 140, 352 106"/>
      <path id="pipeX" class="fpipe" d="M470 196 C 400 232, 220 232, 150 196"/>
      <path id="flowG" class="fflow g" d="M150 168 C 210 168, 240 140, 268 106"/>
      <path id="flowP" class="fflow p" d="M470 168 C 410 168, 380 140, 352 106"/>
      <path id="flowX" class="fflow p" d="M470 196 C 400 232, 220 232, 150 196"/>

      <!-- โหลด (บนกลาง) -->
      <rect id="nLoad" class="fnode" x="248" y="34" width="124" height="72" rx="14"/>
      <text class="ficon" x="310" y="62">🏭</text>
      <text class="fval load" x="310" y="92"><tspan id="fLoad">–</tspan> kW</text>
      <text class="fname" x="310" y="124">โหลดรวมทั้งโรงงาน</text>

      <!-- การไฟฟ้า (ล่างซ้าย) -->
      <rect id="nGrid" class="fnode" x="26" y="146" width="124" height="72" rx="14"/>
      <text class="ficon" x="88" y="174">🗼</text>
      <text class="fval grid" x="88" y="204"><tspan id="fGrid">–</tspan> kW</text>
      <text class="fname" x="88" y="236">การไฟฟ้า</text>

      <!-- โซลาร์ (ล่างขวา) -->
      <rect id="nPv" class="fnode" x="470" y="146" width="124" height="72" rx="14"/>
      <text class="ficon" x="532" y="174">☀️</text>
      <text class="fval pv" x="532" y="204"><tspan id="fPv">–</tspan> kW</text>
      <text class="fname" x="532" y="236">โซลาร์</text>
    </svg>
    <div class="label" id="flowNote" style="margin-top:6px"></div>
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

  <div class="card" id="billCard" style="display:none">
    <div class="label">💰 ค่าไฟ <span style="color:#64748b">— ประมาณการจากที่ระบบวัดได้เอง ไม่ใช่บิลจริง</span></div>
    <div class="billtop">
      <div>
        <div class="label" id="billDayLabel">วันนี้ <small style="color:#64748b">(เฉพาะค่าพลังงาน)</small></div>
        <div class="bigbaht"><span id="billDay">–</span><span class="cur">บาท</span></div>
        <div class="label" id="billDaySub" style="margin-top:6px"></div>
      </div>
      <div>
        <div class="label" id="billMonthLabel">เดือนนี้ <small style="color:#64748b">(รวมทุกรายการ)</small></div>
        <div class="bigbaht month"><span id="billMonth">–</span><span class="cur">บาท</span></div>
        <div class="label" id="billMonthSub" style="margin-top:6px"></div>
      </div>
    </div>
    <table class="brk">
      <tr><td>ค่าพลังงาน ช่วง Peak <small id="brkOnKwh"></small></td><td id="brkOn">–</td></tr>
      <tr><td>ค่าพลังงาน ช่วง Off Peak <small id="brkOffKwh"></small></td><td id="brkOff">–</td></tr>
      <tr><td>ค่า Ft</td><td id="brkFt">–</td></tr>
      <tr><td>ค่าความต้องการพลังไฟฟ้า <small id="brkDemandKw"></small></td><td id="brkDemand">–</td></tr>
      <tr><td>ค่าบริการรายเดือน</td><td id="brkService">–</td></tr>
      <tr><td>ภาษีมูลค่าเพิ่ม 7%</td><td id="brkVat">–</td></tr>
      <tr class="sum"><td>รวมค่าไฟเดือนนี้</td><td id="brkTotal">–</td></tr>
    </table>
    <div class="label" id="billNote" style="margin-top:12px"></div>
  </div>

  <div class="card" id="shedCard" style="display:none;margin-top:16px;border-color:#7c3aed">
    <div class="label">🤖 ระบบสั่งปิดอัตโนมัติอยู่ตอนนี้</div>
    <div id="shedList" style="font-size:18px;line-height:1.9;margin-top:8px"></div>
    <div class="label" style="margin-top:10px">พิมพ์ /restore ในกลุ่ม Telegram ถ้าต้องการเปิดกลับทันที</div>
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
      <span><i class="dot" style="background:#f59e0b55"></i>แถบส้ม = ช่วงเฝ้าระวังเข้ม</span>
    </div>
  </div>

  <!-- สรุปของเดือนอยู่ล่างสุด เพราะเป็นข้อมูลย้อนหลังไว้หาสาเหตุ ไม่ใช่ของที่ต้องรีบดู
       ลำดับบนหน้าจอจึงเป็น: สถานะตอนนี้ > สิ่งที่ต้องทำ > กราฟวันนี้ > สรุปเดือน -->
  <div class="card" id="monthCard" style="display:none">
    <div class="label">📅 สูงสุดของเดือน <span id="mkey"></span></div>
    <table class="peaks">
      <thead><tr><th>รายการ</th><th>สูงสุด</th><th>เมื่อ</th></tr></thead>
      <tbody>
        <tr class="hi">
          <td>ไฟจากการไฟฟ้า<small>เฉลี่ย 15 นาที — ตัวที่การไฟฟ้าใช้คิดเงิน</small></td>
          <td id="pkDemand">–</td><td id="pkDemandAt">–</td>
        </tr>
        <tr>
          <td>ไฟจากการไฟฟ้า<small>ค่า ณ ขณะนั้น</small></td>
          <td id="pkGrid">–</td><td id="pkGridAt">–</td>
        </tr>
        <tr>
          <td>โหลดรวมทั้งโรงงาน<small>ค่า ณ ขณะนั้น</small></td>
          <td id="pkLoad">–</td><td id="pkLoadAt">–</td>
        </tr>
        <tr>
          <td>โซลาร์ผลิตได้<small>ค่า ณ ขณะนั้น</small></td>
          <td id="pkPv">–</td><td id="pkPvAt">–</td>
        </tr>
      </tbody>
    </table>
    <div class="label" style="margin-top:12px">แถวแรกคือตัวที่ตัดสินว่าจะโดนย้ายประเภทค่าไฟไหม อีก 3 แถวไว้ดูย้อนหลังว่าวันนั้นเกิดอะไรขึ้น</div>
  </div>

  <footer>
    <span id="updated">—</span>
    <a href="/loads" style="color:#60a5fa;text-decoration:none">⚡ วัดโหลดรายโซน →</a>
  </footer>
</div>

<script>
const TOKEN = ${JSON.stringify(q)};
const WATCH_HOUR = ${Number(cfg.eveningWatchHour) || 15};
/* ช่วงเวลาที่กราฟแสดง — ตัดกลางดึกที่ร้านปิดแล้วออกไป */
const CHART_FROM = ${Number(cfg.chartStartHour) || 5.5};
const CHART_TO = ${Number(cfg.chartEndHour) || 21};
/* เสียงเปิดไว้เป็นค่าตั้งต้น — ต้องกดปิดเองถึงจะเงียบ
   ของเดิมต้องกดเปิดทุกครั้งที่เปิดหน้าใหม่ ซึ่งแปลว่าจอที่รีเฟรชเองหรือเครื่อง
   ที่เพิ่งรีสตาร์ทจะกลับไปเงียบสนิทโดยไม่มีใครรู้ จนถึงวันที่ต้องพึ่งมันจริง ๆ */
let soundOn = localStorage.getItem('solarSound') !== '0';
let audioCtx = null, sirenTimer = null, lastLevel = 'green';

const btn = document.getElementById('soundBtn');
const soundBar = document.getElementById('soundBar');
const soundState = document.getElementById('soundState');
function paintBtn(){
  const blocked = audioBlocked();
  btn.textContent = soundOn ? 'ปิดเสียง' : 'เปิดเสียง';
  soundState.innerHTML = !soundOn
    ? '🔇 <b>เสียงเตือนถูกปิดอยู่</b> — ตอนไฟแดงจะไม่มีเสียงอะไรเลย'
    : blocked
      ? '👆 <b>แตะที่หน้าจอหนึ่งครั้ง</b> เพื่อปลดล็อกเสียง (เบราว์เซอร์บังคับ)'
      : '🔊 เสียงเตือนเปิดอยู่ พร้อมส่งเสียงเมื่อไฟแดง';
  soundBar.className = 'soundbar' + (soundOn && !blocked ? '' : ' off');
}
btn.onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem('solarSound', soundOn ? '1' : '0');
  if (soundOn) {
    ensureAudio(); beep(880, 0.15);
    /* ขอสิทธิ์แจ้งเตือนตอนนี้เลย ต้องขอตอนคนกดปุ่มเท่านั้น เบราว์เซอร์ถึงจะยอม */
    try { if('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch(e){}
  } else stopSiren();
  paintBtn(); paintAudioWarn();
};

/* ลองปลดล็อกเสียงทันทีที่เปิดหน้า — ได้ผลบนจอติดผนังที่เคยแตะไว้แล้ว
   ถ้าเบราว์เซอร์ไม่ยอม แถบด้านบนจะเป็นสีแดงบอกให้แตะหน้าจอ ไม่เงียบหายไปเฉย ๆ */
try { ensureAudio(); } catch(e){}
paintBtn();
setInterval(paintBtn, 3000);

/* ทดสอบเสียงได้โดยไม่ต้องรอให้ไฟหลวงพุ่งจริง
   ก่อนหน้านี้ทางเดียวที่จะได้ยินไซเรนคือรอให้สถานะเป็นแดงจริง ซึ่งแปลว่า
   ไม่มีใครรู้เลยว่าเสียงใช้ได้ไหม จนกว่าจะถึงวินาทีที่พึ่งมันไม่ได้แล้ว
   ปุ่มนี้เปิดเสียงให้เองด้วย เพราะการกดปุ่มคือ user gesture ที่เบราว์เซอร์ต้องการ */
const testBtn = document.getElementById('testBtn');
let testing = false;
testBtn.onclick = () => {
  if (testing) return;
  testing = true;
  if (!soundOn) {
    soundOn = true;
    localStorage.setItem('solarSound', '1');
  }
  paintBtn();
  ensureAudio();
  try { if('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch(e){}

  const box = document.getElementById('status');
  const wasClass = box.className;
  box.className = 'status red';                    /* ให้เห็นด้วยว่าตอนแดงหน้าตาเป็นยังไง */
  testBtn.textContent = '🔊 กำลังทดสอบ…';

  let n = 0;
  siren();
  const iv = setInterval(() => {
    if (++n >= 3) {
      clearInterval(iv);
      box.className = wasClass;
      testBtn.textContent = '🔔 ทดสอบเสียงไซเรน';
      testing = false;
      paintAudioWarn();
      if (audioBlocked()) alert('เบราว์เซอร์ยังบล็อกเสียงอยู่ ลองแตะที่หน้าจอแล้วกดใหม่อีกครั้ง');
      return;
    }
    siren();
  }, 1400);
};

/* เบราว์เซอร์ห้ามเล่นเสียงจนกว่าคนจะแตะหน้าเว็บก่อน จอที่เปิดค้างไว้เฉย ๆ
   จึงเงียบสนิทตอนเกิดเรื่อง โดยที่ไม่มีใครรู้ว่ามันเงียบ
   ถ้าเปิดเสียงไว้แล้วแต่เบราว์เซอร์ยังบล็อกอยู่ ต้องบอกให้เห็นชัด ๆ ไม่ใช่เงียบไป */
function audioBlocked(){
  return soundOn && (!audioCtx || audioCtx.state === 'suspended');
}
/* แถบเสียงบนสุดบอกสถานะนี้อยู่แล้ว ไม่ต้องมีกล่องเตือนซ้ำอีกกล่องกลางหน้า */
const paintAudioWarn = paintBtn;
/* แตะตรงไหนก็ได้ = ปลดล็อกเสียง (เบราว์เซอร์นับว่าเป็น user gesture) */
['click','touchstart','keydown'].forEach((ev) =>
  document.addEventListener(ev, () => { if(soundOn){ ensureAudio(); paintAudioWarn(); paintBtn(); } }, { passive: true }));

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
/* ไซเรนสามชั้น ให้ได้ยินข้ามเสียงเครื่องจักรในโรงงาน
   ชั้นล่าง = ตัวเสียงหนัก / ชั้นกลาง = เสียงกวาดที่หูจับได้ไกล / ชั้นบน = ความแหลมที่ทะลุเสียงรบกวน
   ดังกว่าเดิมราว 3 เท่า และซ้ำถี่กว่าเดิม 3 เท่า (1.4 วิ แทน 4 วิ) */
function siren(){
  if(!soundOn) return; ensureAudio();
  const t = audioCtx.currentTime;
  const master = audioCtx.createGain();
  master.gain.value = 0.95;
  master.connect(audioCtx.destination);

  const layer = (type, f0, f1, peak, dur, delay) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.connect(g); g.connect(master);
    const s = t + delay;
    o.frequency.setValueAtTime(f0, s);
    o.frequency.linearRampToValueAtTime(f1, s + dur*0.55);
    o.frequency.linearRampToValueAtTime(f0, s + dur);
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(peak, s + 0.03);
    g.gain.setValueAtTime(peak, s + dur*0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
    o.start(s); o.stop(s + dur + 0.05);
  };

  layer('square',   115,  190, 0.55, 1.15, 0);     /* ตัวเสียงหนัก */
  layer('sawtooth', 620, 1350, 0.45, 1.15, 0);     /* เสียงกวาดแบบไซเรน */
  layer('sawtooth', 1240, 1360, 0.18, 1.15, 0);    /* ความแหลม */

  /* มือถือที่เปิดหน้านี้ค้างไว้ ให้สั่นด้วย เผื่ออยู่ในที่เสียงดังจนไม่ได้ยิน */
  try { if(navigator.vibrate) navigator.vibrate([450, 120, 450]); } catch(e){}
}

let titleFlip = null;
const BASE_TITLE = document.title;
function startSiren(){
  if(sirenTimer) return;
  siren(); sirenTimer = setInterval(siren, 1400);
  /* แท็บที่ถูกซ่อนอยู่ก็ต้องรู้ตัว — สลับชื่อแท็บให้กะพริบ */
  if(!titleFlip){
    let on = false;
    titleFlip = setInterval(()=>{ on = !on; document.title = on ? '🔴 ลดการใช้ไฟด่วน!' : BASE_TITLE; }, 900);
  }
  notifyOnce();
}
function stopSiren(){
  if(sirenTimer){ clearInterval(sirenTimer); sirenTimer=null; }
  if(titleFlip){ clearInterval(titleFlip); titleFlip=null; document.title = BASE_TITLE; }
  lastNotified = 0;
}

/* แจ้งเตือนระดับเบราว์เซอร์ เห็นได้แม้สลับไปแท็บอื่นหรือย่อหน้าต่างไว้ */
let lastNotified = 0;
function notifyOnce(){
  try{
    if(!('Notification' in window) || Notification.permission !== 'granted') return;
    if(Date.now() - lastNotified < 120000) return;   /* ไม่ยิงถี่กว่า 2 นาที */
    lastNotified = Date.now();
    const n = new Notification('🔴 ไฟจากการไฟฟ้าเข้าหนัก', {
      body: 'ให้ไปปิดอุปกรณ์ตามรายการบนหน้าจอทันที',
      tag: 'solar-guard-red',
      renotify: true,
      requireInteraction: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  }catch(e){}
}

const HEADLINES = {
  green: ['🟢 ปกติ — โซลาร์รับไหว', 'ใช้ไฟได้ตามปกติ'],
  yellow:['🟡 เริ่มดึงไฟหลวงเยอะ', 'เตรียมลดการใช้ไฟ ถ้าปิดอะไรได้ให้ปิดก่อน'],
  red:   ['🔴 ลดการใช้ไฟตอนนี้', 'ไฟจากการไฟฟ้าเข้าหนัก ให้ปิดอุปกรณ์ตามรายการด้านล่างทันที'],
  stale: ['⚪ ไม่ได้รับข้อมูล', 'ระบบยังติดต่อ FusionSolar ไม่ได้ ให้แจ้งฝ่ายไอที']
};

function fmt(n, d){ return n===null||n===undefined ? '–' : Number(n).toFixed(d===undefined?1:d); }
/* กำลังไฟแสดง 3 ตำแหน่ง — ตอนวัดโหลดทีละตัวค่าต่างกันระดับ 0.05 kW มีความหมาย
   ส่วน kWh กับเงินยังใช้ตำแหน่งเดียวเหมือนเดิม เพราะเป็นตัวเลขก้อนใหญ่ */
function fkw(n){ return fmt(n, 3); }

/* "1,234" — ใส่จุลภาคให้อ่านง่ายบนจอไกล ๆ ปัดเป็นจำนวนเต็มบาท */
function baht(n){ return n===null||n===undefined ? '–' : Math.round(Number(n)).toLocaleString('th-TH'); }

/* "3 ส.ค. 13:45" — บวก 7 ชม.เอง ไม่พึ่งเวลาเครื่อง เพราะจอติดผนังบางเครื่องตั้งโซนผิด */
const TH_MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function thWhen(ts){
  if(!ts) return '–';
  const d = new Date(ts + 7*3600*1000);
  const p = n => String(n).padStart(2,'0');
  return d.getUTCDate() + ' ' + TH_MON[d.getUTCMonth()] + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

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

  document.getElementById('grid').innerHTML = fkw(st.gridImportKw) + '<span class="unit">kW</span>';
  document.getElementById('pv').innerHTML   = fkw(st.pvKw) + '<span class="unit">kW</span>';
  document.getElementById('load').innerHTML = fkw(st.loadKw) + '<span class="unit">kW</span>';
  const cov = st.coveragePct==null ? 0 : st.coveragePct;
  document.getElementById('cov').innerHTML  = fmt(cov,0) + '<span class="unit">%</span>';
  document.getElementById('covbar').style.width = Math.max(0,Math.min(100,cov)) + '%';
  document.getElementById('thresholds').textContent = 'เกณฑ์: เหลือง ' + st.warnKw + ' / แดง ' + st.critKw + ' kW';

  /* ---- เพดานการไฟฟ้าของเดือน: ตัวเลขที่สำคัญที่สุดบนหน้านี้ ---- */
  const m = st.month;
  if (m) {
    document.getElementById('mpeak').textContent = fmt(m.peakKw);
    document.getElementById('mlimit').textContent = m.limitKw;
    document.getElementById('mbar').style.width = Math.min(100, m.usedPct) + '%';
    const hd = document.querySelector('.headroom');
    document.getElementById('mhead').innerHTML = (m.breached ? '0' : fmt(m.headroomKw)) + '<span class="unit">kW</span>';
    hd.className = 'headroom' + (m.breached ? ' none' : m.headroomKw <= 4 ? ' low' : '');
    const cc = document.getElementById('ceilingCard');
    cc.className = 'card ceiling' + (m.breached || m.headroomKw <= 2 ? ' danger' : m.headroomKw <= 5 ? ' warn' : '');
    document.getElementById('mnote').textContent = m.breached
      ? '🛑 เดือนนี้เกินเพดานไปแล้ว — เริ่มนับใหม่เดือนหน้า'
      : 'ใช้ไปแล้ว ' + m.usedPct + '% ของเพดาน • เกิน ' + m.limitKw + ' kW แม้ครั้งเดียว = ค่าไฟประเภทที่ 3 นาน 12 เดือน';
  }

  /* ---- แผนภาพไฟวิ่ง + เตือนว่าเสียงถูกบล็อกอยู่ ---- */
  drawFlow(st);
  paintAudioWarn();

  /* ---- แถบเฝ้าระวังเข้มช่วงเย็น ---- */
  const eb = document.getElementById('eveBanner');
  const ev = st.eveningWatch;
  if (ev && ev.active) {
    eb.style.display = 'block';
    eb.innerHTML = '<b>⚠️ ช่วงเฝ้าระวังเข้ม (หลัง ' + ev.fromHour + ':00 น.)</b><br>'
      + 'แดดเริ่มตกแต่เครื่องยังเดินอยู่ ส่วนที่โซลาร์เคยแบกให้จะกลายเป็นไฟหลวงเอง '
      + 'และช่วงนี้ยังอยู่ใน Peak ที่การไฟฟ้าคิดค่าความต้องการพลังไฟฟ้า พีคที่เกิดตอนนี้จึงแพงที่สุดของวัน<br>'
      + 'เกณฑ์เตือนลดลงชั่วคราวเป็น <b>เหลือง ' + fmt(st.warnKw,0) + ' / แดง ' + fmt(st.critKw,0) + ' kW</b>'
      + ' (ปกติ ' + fmt(ev.baseWarnKw,0) + ' / ' + fmt(ev.baseCritKw,0) + ')';
  } else {
    eb.style.display = 'none';
  }

  /* ---- ค่าไฟวันนี้ / เดือนนี้ ---- */
  const bc = document.getElementById('billCard');
  const bl = st.bill;
  if (bl && bl.month) {
    bc.style.display = 'block';
    const set = (id, v) => { document.getElementById(id).textContent = v; };
    set('billDay', baht(bl.day.totalBaht));
    set('billMonth', baht(bl.month.totalBaht));
    set('billDaySub', 'ซื้อไฟ ' + fmt(bl.day.totalKwh) + ' kWh');
    set('billMonthSub', 'ซื้อไฟ ' + fmt(bl.month.totalKwh) + ' kWh');

    /* ป้ายต้องบอกช่วงที่วัดได้จริง ไม่ใช่เขียน "วันนี้" ทั้งที่เพิ่งเริ่มนับตอนบ่าย
       ตัวเลขถูก แต่ถ้าป้ายบอกกว้างกว่าของจริง คนอ่านจะสรุปผิดว่าระบบคิดเลขพลาด */
    const since = bl.month.since || 0;
    const sinceD = new Date(since + 7*3600000);
    const nowD = new Date(Date.now() + 7*3600000);
    const startedToday = since && sinceD.toISOString().slice(0,10) === nowD.toISOString().slice(0,10);
    const startedThisMonth1st = since && sinceD.getUTCDate() === 1 && sinceD.getUTCHours() === 0;

    document.getElementById('billDayLabel').innerHTML = startedToday
      ? 'ตั้งแต่ ' + thWhen(since).split(' ').slice(2).join(' ') + ' น. ถึงตอนนี้ <small style="color:#64748b">(เฉพาะค่าพลังงาน)</small>'
      : 'วันนี้ <small style="color:#64748b">(เฉพาะค่าพลังงาน)</small>';
    document.getElementById('billMonthLabel').innerHTML = (since && !startedThisMonth1st)
      ? 'ตั้งแต่ ' + thWhen(since) + ' น. <small style="color:#64748b">(รวมทุกรายการ)</small>'
      : 'เดือนนี้ <small style="color:#64748b">(รวมทุกรายการ)</small>';
    set('brkOnKwh', '(' + fmt(bl.month.onPeakKwh) + ' kWh)');
    set('brkOffKwh', '(' + fmt(bl.month.offPeakKwh) + ' kWh)');
    set('brkOn', baht(bl.month.energyOnBaht));
    set('brkOff', baht(bl.month.energyOffBaht));
    set('brkFt', baht(bl.month.ftBaht));
    set('brkDemandKw', '(' + fmt(bl.month.demandKw) + ' kW' + (bl.month.demandAt ? ' เมื่อ ' + thWhen(bl.month.demandAt) : '') + ')');
    set('brkDemand', baht(bl.month.demandBaht));
    set('brkService', baht(bl.month.serviceBaht));
    set('brkVat', baht(bl.month.vatBaht));
    set('brkTotal', baht(bl.month.totalBaht) + ' บาท');
    /* ข้อมูลขาดช่วง = ตัวเลขต่ำกว่าจริงเสมอ ต้องบอกให้รู้ ไม่ใช่โชว์เฉย ๆ */
    const miss = bl.month.missedMin;
    /* ค่าบริการ 312 บาทเป็นยอดเต็มเดือนเสมอ ถ้าเพิ่งเริ่มนับได้ไม่กี่ชั่วโมง
       ยอด "เดือนนี้" จะดูใหญ่เกินจริงมาก ต้องเตือนให้ชัด ไม่ใช่ปล่อยให้เข้าใจผิด */
    const partial = !startedThisMonth1st;
    document.getElementById('billNote').innerHTML =
      (partial
        ? '<b style="color:#f59e0b">⚠️ ยังไม่ครบเดือน</b> — เริ่มเก็บข้อมูลเมื่อ ' + thWhen(since) + ' น. '
          + 'ค่าพลังงานจึงนับเฉพาะจากตอนนั้น ส่วนค่าบริการ ' + baht(bl.month.serviceBaht) + ' บาท เป็นยอดเต็มเดือนเสมอ<br>'
        : 'เริ่มนับตั้งแต่ต้นเดือน<br>')
      + (miss > 5 ? '<b style="color:#f59e0b">ข้อมูลขาดไป ' + Math.round(miss) + ' นาที ตัวเลขจริงสูงกว่านี้</b> • ' : '')
      + 'กดพีคช่วง Peak ลงได้ 1 kW = ประหยัด ' + baht(bl.month.perKwBaht) + ' บาท/เดือน';
  } else {
    bc.style.display = 'none';
  }

  /* ---- สูงสุดของเดือน แยกทีละสาย พร้อมวันเวลาที่เกิด ---- */
  const mc = document.getElementById('monthCard');
  const mp = st.monthPeaks;
  if (m) {
    mc.style.display = 'block';
    document.getElementById('mkey').textContent = m.monthKey || '';
    /* แถวแรกใช้ค่าที่ล็อกแล้ว ไม่ใช่ค่า live — ถ้าหน้าต่างที่กำลังเดินอยู่ยังไม่จบ
       มันยังเปลี่ยนได้ เอามาโชว์คู่กับ "วันไหน" จะทำให้เข้าใจผิดว่าเกิดขึ้นแล้ว */
    document.getElementById('pkDemand').textContent = fmt(m.lockedPeakKw) + ' kW';
    document.getElementById('pkDemandAt').textContent = thWhen(m.peakAt);
    const rows = [['pkGrid', mp && mp.gridKw, mp && mp.gridAt],
                  ['pkLoad', mp && mp.loadKw, mp && mp.loadAt],
                  ['pkPv',   mp && mp.pvKw,   mp && mp.pvAt]];
    for (const [id, kw, at] of rows) {
      document.getElementById(id).textContent = kw ? fmt(kw) + ' kW' : '–';
      document.getElementById(id + 'At').textContent = kw ? thWhen(at) : '–';
    }
  } else {
    mc.style.display = 'none';
  }

  /* ---- หน้าต่าง 15 นาทีปัจจุบัน ---- */
  const d = st.demand;
  const wc = document.getElementById('winCard');
  if (d) {
    wc.style.display = 'block';
    document.getElementById('wtime').textContent = d.elapsedMin + ' / ' + d.remainMin + ' นาที';
    document.getElementById('wavg').textContent = fkw(d.avgSoFarKw) + ' kW';
    const proj = document.getElementById('wproj');
    proj.textContent = fkw(d.projectedKw) + ' kW';
    proj.className = 'wv' + (st.targets && d.projectedKw >= st.targets.actionKw ? ' alarm' : '');
    const allow = document.getElementById('wallow');
    /* ถ้าเวลาที่เหลือใช้ได้มากกว่าเพดานของทั้งเดือน แปลว่าหน้าต่างนี้ไม่มีทางเกิน
       ต่อให้เปิดทุกอย่างพร้อมกัน — โชว์ตัวเลขอย่าง "39.700 kW" ในไซต์ที่พีค
       สูงสุดเคยแค่ 26 kW ทำให้คนอ่านนึกว่าระบบคำนวณพัง ทั้งที่เลขถูกทางคณิตศาสตร์ */
    const cap = (st.month && st.month.limitKw) || 0;
    allow.textContent = d.blown ? 'เกินแล้ว'
      : (cap && d.allowedRestKw > cap) ? 'ใช้ได้เต็มที่'
      : fkw(Math.max(0, d.allowedRestKw)) + ' kW';
    allow.className = 'wv' + (d.blown ? ' alarm' : '');
  } else wc.style.display = 'none';
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

  /* ---- โซนที่ระบบสั่งปิดอยู่ ---- */
  const sc = document.getElementById('shedCard');
  const offZones = (st.autoshed && st.autoshed.offZones) || [];
  if(offZones.length){
    document.getElementById('shedList').innerHTML = offZones.map(z =>
      '⛔ ' + escapeHtml(z.name) + ' <b>(−' + z.kw + ' kW)</b>').join('<br>');
    sc.style.display='block';
  } else sc.style.display='none';

  /* ไซเรนตามสัญญาณฉุกเฉินของ worker ไม่ใช่ตามสีของสถานะ
     สีเขียวไม่ได้แปลว่าปลอดภัย — หน้าต่าง 15 นาทีอาจกำลังจะจบเกินเพดานอยู่ก็ได้
     ทั้งที่ค่า ณ วินาทีนี้ยังต่ำ (?? ไว้เผื่อ worker รุ่นเก่าที่ยังไม่ส่ง emergency มา) */
  const emg = st.emergency ?? (level === 'red');
  if(emg) startSiren(); else stopSiren();
  const eb2 = document.getElementById('emgLine');
  eb2.style.display = emg && st.emergencyReason ? 'block' : 'none';
  if (emg && st.emergencyReason) eb2.textContent = '🚨 ' + st.emergencyReason;
  if(level!=='red' && lastLevel==='red') beep(660,0.25);
  lastLevel = level;
  drawChart(samples);
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* แผนภาพไฟวิ่ง — ยิ่งกำลังไฟมาก เส้นประยิ่งวิ่งเร็ว
   ไม่ได้ใช้ requestAnimationFrame เพราะจอนี้เปิดค้างทั้งวัน ปล่อยให้ CSS
   จัดการแอนิเมชันจะกินซีพียูน้อยกว่ามาก และหยุดเองเมื่อแท็บถูกซ่อน */
function drawFlow(st){
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  const grid = st.gridImportKw, pv = st.pvKw, load = st.loadKw;
  const dead = st.stale || grid === null || grid === undefined;

  set('fGrid', dead ? '–' : fkw(Math.abs(grid)));
  set('fPv', dead ? '–' : fkw(pv));
  set('fLoad', dead ? '–' : fkw(load));

  /* เกณฑ์ให้เส้นวิ่ง = ครึ่งหนึ่งของหน่วยที่เล็กที่สุดที่หน้าจอแสดง (0.001 kW)
     ต้องผูกกับความละเอียดของตัวเลขเสมอ ไม่งั้นจะขัดกันเอง — ของเดิมตั้งไว้ 0.15
     ตั้งแต่ตอนที่ยังแสดงทศนิยมตำแหน่งเดียว พอเปลี่ยนเป็น 3 ตำแหน่ง หน้าจอเลย
     บอกว่าซื้อไฟอยู่ 0.003 kW แต่เส้นนิ่งสนิท ซึ่งอ่านแล้วเหมือนระบบค้าง */
  const MIN = 0.0005;
  const importing = !dead && grid > MIN;
  const exporting = !dead && grid < -MIN;

  /* เร็วสุด 0.45 วิ/รอบ ที่ 20 kW ขึ้นไป ช้าสุด 2.6 วิ/รอบ ตอนเกือบนิ่ง */
  const speed = (kw) => Math.max(0.45, 2.6 - Math.min(20, Math.abs(kw)) * 0.108).toFixed(2) + 's';

  const line = (id, on, dur, rev) => {
    const el = document.getElementById(id);
    el.classList.toggle('on', !!on);
    el.classList.toggle('rev', !!rev);
    if (on) el.style.animationDuration = dur;
  };
  line('flowG', importing, speed(grid), false);              /* การไฟฟ้า -> โหลด */
  line('flowP', !dead && pv > MIN, speed(pv), false);        /* โซลาร์ -> โหลด */
  line('flowX', exporting, speed(grid), true);               /* โซลาร์ -> การไฟฟ้า */

  document.getElementById('nGrid').classList.toggle('act', importing || exporting);
  document.getElementById('nPv').classList.toggle('act', !dead && pv > MIN);
  document.getElementById('nLoad').classList.toggle('act', !dead && load > MIN);

  document.getElementById('flowAge').textContent = dead ? '— ข้อมูลขาดการติดต่อ' : '';
  document.getElementById('flowNote').innerHTML = dead
    ? 'ยังไม่มีข้อมูลสด'
    : exporting
      ? 'กำลัง<b>ขายไฟออก</b> ' + fkw(Math.abs(grid)) + ' kW — โซลาร์ผลิตเกินที่โรงงานใช้'
      : importing
        ? 'โซลาร์แบกโหลดได้ ' + (st.coveragePct == null ? '–' : st.coveragePct) + '% ที่เหลือ '
          + fkw(grid) + ' kW <b>ซื้อจากการไฟฟ้า</b> ≈ ' + baht(grid * (st.tariffNow || 4.65)) + ' บาท/ชม.'
        : 'โซลาร์แบกโหลดได้ทั้งหมด ไม่ได้ซื้อไฟเลยตอนนี้';
}

function drawChart(samples){
  const c = document.getElementById('chart'), ctx = c.getContext('2d');
  const dpr = devicePixelRatio;
  const w = c.width = c.clientWidth * dpr, h = c.height = 230 * dpr;
  ctx.clearRect(0,0,w,h);
  if(samples.length < 2) return;

  /* เว้นขอบไว้ใส่ตัวเลข kW ด้านซ้าย และเวลาด้านล่าง */
  const padL = 40*dpr, padR = 8*dpr, padT = 8*dpr, padB = 24*dpr;
  const pw = w - padL - padR, ph = h - padT - padB;

  /* แกนเวลาตรึงไว้ที่ช่วงเดิมของทุกวัน ไม่ใช่ยืดตามข้อมูลที่มี
     ทำให้ดูวันนี้เทียบวันก่อนได้ ตำแหน่งเดียวกันคือเวลาเดียวกันเสมอ
     และช่วงที่ข้อมูลขาดจะเห็นเป็นช่องว่างตรงตำแหน่งจริง ไม่ถูกบีบหายไป

     ตัดกลางดึกทิ้ง (ค่าเริ่มต้น 05:30-21:00) เพราะร้านปิดแล้ว เหลือแต่เส้นแบน
     กินพื้นที่ครึ่งจอโดยไม่ได้บอกอะไร */
  const dayStart = (t) => { const d = new Date(t + 7*3600000); d.setUTCHours(0,0,0,0); return d.getTime() - 7*3600000; };
  const d0 = dayStart(samples[0].t);
  const t0 = d0 + CHART_FROM*3600000;
  const t1 = d0 + CHART_TO*3600000;
  const span = Math.max(1, t1 - t0);
  const max = Math.max(10, ...samples.map(s=>Math.max(s.pv||0, s.load||0, s.grid||0))) * 1.15;

  /* วางตามเวลาจริง ไม่ใช่ตามลำดับจุด — ช่วงที่ข้อมูลขาดจะได้เห็นเป็นช่องว่างจริง ๆ
     ไม่ใช่ถูกบีบให้ดูเหมือนต่อเนื่อง ซึ่งทำให้อ่านเวลาผิด */
  const x = t => padL + ((t - t0)/span)*pw;
  const y = v => padT + (1 - Math.max(0,v)/max)*ph;

  /* แถบเฝ้าระวังเข้มช่วงเย็น (15:00 เป็นต้นไป) ระบายพื้นหลังให้เห็นว่าอันตรายช่วงไหน */
  for(let d = t0; d <= t1; d += 86400000){
    const a = d + WATCH_HOUR*3600000, b = d + 22*3600000;
    if(b < t0 || a > t1) continue;
    const xa = x(Math.max(a,t0)), xb = x(Math.min(b,t1));
    ctx.fillStyle = '#f59e0b14';
    ctx.fillRect(xa, padT, Math.max(1,xb-xa), ph);
    ctx.strokeStyle = '#f59e0b55'; ctx.lineWidth = dpr; ctx.setLineDash([4*dpr,4*dpr]);
    ctx.beginPath(); ctx.moveTo(xa, padT); ctx.lineTo(xa, padT+ph); ctx.stroke();
    ctx.setLineDash([]);
  }

  /* เส้นแนวนอน + ตัวเลข kW */
  ctx.font = (11*dpr)+'px system-ui,sans-serif';
  ctx.fillStyle = '#64748b'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for(let i=0;i<=4;i++){
    const v = (max/4)*i, gy = y(v);
    ctx.strokeStyle='#1e293b'; ctx.lineWidth=dpr;
    ctx.beginPath(); ctx.moveTo(padL,gy); ctx.lineTo(w-padR,gy); ctx.stroke();
    ctx.fillText(Math.round(v), padL-6*dpr, gy);
  }

  /* เส้นแนวตั้ง + เวลา — เลือกระยะห่างให้ป้ายไม่ทับกัน */
  const hours = span/3600000;
  /* 15-16 ชั่วโมงยังอ่านทุก 2 ชั่วโมงได้สบาย ไม่ต้องกระโดดเป็น 4 */
  const step = hours > 20 ? 4 : hours > 7 ? 2 : 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const first = Math.ceil((t0 + 7*3600000)/(step*3600000))*(step*3600000) - 7*3600000;
  for(let t = first; t <= t1; t += step*3600000){
    const gx = x(t);
    ctx.strokeStyle='#1e293b'; ctx.lineWidth=dpr;
    ctx.beginPath(); ctx.moveTo(gx,padT); ctx.lineTo(gx,padT+ph); ctx.stroke();
    const hh = new Date(t + 7*3600000).getUTCHours();
    ctx.fillStyle = hh >= WATCH_HOUR && hh < 22 ? '#f59e0b' : '#64748b';
    ctx.fillText(String(hh).padStart(2,'0')+':00', gx, padT+ph+6*dpr);
  }

  /* ข้อมูลขาดเกิน 20 นาที = ยกปากกา ไม่ลากเส้นข้ามช่องว่าง
     ไม่งั้นช่วงที่เครื่องอ่านปิดจะกลายเป็นเส้นตรงสวย ๆ ที่ไม่เคยเกิดขึ้นจริง */
  const GAP = 20*60000;
  const line = (key,color) => {
    ctx.strokeStyle=color; ctx.lineWidth=2.5*dpr; ctx.lineJoin='round'; ctx.lineCap='round';
    ctx.beginPath();
    let pen = false;
    samples.forEach((s,i)=>{
      if(i && s.t - samples[i-1].t > GAP) pen = false;
      if(pen) ctx.lineTo(x(s.t), y(s[key])); else { ctx.moveTo(x(s.t), y(s[key])); pen = true; }
    });
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
