# ดึงข้อมูลจากหน้าเว็บ FusionSolar (`FusionWebReader.ps1`)

ตัวอ่านค่าที่ใช้ **ช่องทางเดียวกับที่หน้า Monitoring → Overview ใช้** แล้วส่งเข้า
`POST /api/ingest` ของ Solar Guard — เขียนด้วย PowerShell ล้วน ไม่ต้องมี Python

> ทำไมต้องใช้ทางนี้: Northbound API ต้องขอดีลเลอร์, Modbus TCP ต้องใช้เฟิร์มแวร์
> SDongle SPC127 (ของที่นี่ SPC116), Kiosk ไม่มีข้อมูลฝั่งซื้อไฟ — เหลือทางนี้ทางเดียว

---

## API ที่ค้นเจอ (ยืนยันกับของจริงแล้ว 2 ส.ค. 2569)

```
GET /rest/pvms/web/station/v3/overview/energy-flow
    ?stationDn=NE%3D50174729&featureId=aifc
```

ต้องมี session cookie ของ FusionSolar ถึงจะเรียกได้

### ค่าอยู่ตรงไหนใน response

| ตัวเลขบนหน้าจอ | ที่มาใน JSON (`data.flow`) |
|---|---|
| **PV** (Output power) | `nodes[]` ตัวที่ `name` ลงท้าย `devTypeLangKey.string` → `description.value` |
| **Load** (Consumed by appliances) | `nodes[]` ตัวที่ `name` ลงท้าย `kpiView.electricalLoad` → `description.value` |
| **Grid** (Current power) | `links[]` เส้นที่ `fromNode` = `id` ของ node ที่ชื่อลงท้าย `curInfo.grid` |

**กับดักที่ต้องระวัง 2 อย่าง**

1. **`id` ของ node ไม่เท่ากับลำดับใน array** — ที่ไซต์นี้ node ตัวที่ 5 (index 4)
   มี `id` เป็น `"5"` และ `links` อ้างอิงด้วย **`id`** ถ้า parse ด้วย index จะได้ค่าผิด
2. **ค่าเป็น string พร้อมหน่วย** เช่น `"1.308 kW"` ไม่ใช่ตัวเลขล้วน และหน่วยเปลี่ยนได้
   (`W` / `kW` / `MW`) — สคริปต์แปลงหน่วยให้แล้ว

**ทิศทางไฟ**: ปกติจะมีเส้น `grid → meter` = ซื้อไฟเข้า (ค่าบวก)
ถ้าวันไหนขายไฟออกจะกลับเป็น `meter → grid` สคริปต์จะคืนค่า **ติดลบ** ให้อัตโนมัติ

**ตัวตรวจทาน**: `PV + Grid = Load` เสมอ — สคริปต์เช็คให้ทุกครั้งในโหมด `-Probe`

### วิธี login (สแตก UIDM — ของ sg5 ปัจจุบัน)

`sg5` **ไม่ใช้** `/unisso/v2/validateUser.action` แบบที่เอกสารเก่าบอกแล้ว
ของจริงอ่านมาจาก bundle หน้า login เอง (`pvmswebsite/login/build/login.js`
เมธอด `submitLoginApi`):

```
1) POST /rest/dp/uidm/unisso/v1/validate-user?service=<encode ของ /rest/dp/uidm/auth/v1/on-sso-credential-ready>
   header  App-Id: smartpvms
   body    {"username":"...","password":"...","verifycode":""}
   -> payload.redirectURL

2) GET  <redirectURL>?redirectionAddress=<origin><encode ของ /rest/pvms/web/login/v1/redirecturl?isFirst=false>
   header  App-Id: smartpvms, Login-Url-Encode: true
   -> เดินตาม redirect จนจบ คุกกี้ session ถึงจะถูกตั้ง
```

`App-Id` เป็น `pvms` ก็ต่อเมื่อ `brandConfig.common.appidSwitch` เป็นจริง
ซึ่งของที่นี่เป็น `false` → ใช้ **`smartpvms`**

> ถ้าบัญชีเปิด 2FA (รหัสทางอีเมล/SMS) ไว้ จะ login อัตโนมัติไม่ได้ไม่ว่าเขียนยังไง
> ต้องใช้โหมดคุกกี้แทน

---

## ขั้นตอนใช้งาน

### 1. เทสต์ parser แบบไม่ต้อง login (ทำได้เลยเดี๋ยวนี้)

```powershell
powershell -ExecutionPolicy Bypass -File .\FusionWebReader.ps1 -Probe -SampleFile .\sample-energy-flow.json
```

ต้องได้ `PV 1.308 | Grid 0.547 | Load 1.855` และขึ้น `OK`
(`sample-energy-flow.json` คือ response จริงที่บันทึกไว้)

ขั้นนี้ใช้ตรวจซ้ำได้ทุกครั้งที่สงสัยว่า Huawei เปลี่ยนโครงสร้าง JSON

### 2. เก็บรหัสผ่านแบบเข้ารหัส (ทำครั้งเดียว)

```powershell
powershell -ExecutionPolicy Bypass -File .\Setup-Credentials.ps1
```

จะมีหน้าต่างขึ้นมาให้พิมพ์รหัสผ่าน — **รหัสไม่ขึ้นบนจอ ไม่ลง history ไม่อยู่ในไฟล์ไหน
แบบอ่านได้** เก็บลง `fusion-cred.xml` ด้วย DPAPI ของ Windows ซึ่งผูกกับ
**บัญชี Windows ของคุณบนเครื่องนี้เท่านั้น** ก๊อปไฟล์ไปเครื่องอื่นก็ถอดไม่ออก
แถมสคริปต์จะล็อกสิทธิ์ไฟล์ให้เหลือแค่ user คุณคนเดียวด้วย

จะกรอก Worker URL กับ INGEST_TOKEN ตอนนี้เลยก็ได้ หรือกด Enter ข้ามไปก่อนแล้วมาใส่ทีหลัง

> ทำไมไม่ใช้ `setx` — `setx` เขียนรหัสผ่านลง registry แบบอ่านได้ตรง ๆ และโปรแกรมอื่น
> ที่รันในนามคุณก็อ่านได้หมด วิธีนี้ปลอดภัยกว่าและไม่ต้องตั้ง environment variable เลย

### 3. เทสต์กับของจริง

```powershell
powershell -ExecutionPolicy Bypass -File .\FusionWebReader.ps1 -Probe
```

แล้วเปิดหน้า Monitoring → Overview เทียบเลขสามตัวว่าตรงกันไหม

> ⚠️ **จุดที่ยังไม่ได้พิสูจน์** — ตัว login เป็นส่วนเดียวที่ยังไม่ได้ทดสอบจริง
> เพราะทดสอบไม่ได้ถ้าไม่ใส่รหัสผ่าน tenant นี้ใช้ auth stack ใหม่ (UIDM) ซึ่ง
> อาจไม่รับ `/unisso/v2/validateUser.action` แบบเดิมแล้ว
> **ถ้าขั้นนี้ error ให้ข้ามไปข้อ 3** — ส่วนอ่านค่ากับส่งข้อมูลเทสต์ผ่านหมดแล้ว

### 4. ถ้า login อัตโนมัติไม่ผ่าน — ใช้คุกกี้แทน

เปิด Chrome ที่ล็อกอิน FusionSolar ค้างไว้ → F12 → Application → Cookies →
`https://sg5.fusionsolar.huawei.com` แล้วสร้างไฟล์ `cookies.txt` แบบนี้
(บรรทัดละคุกกี้ ชื่อ=ค่า):

```
dp-session=xxxxxxxx
XSRF-TOKEN=xxxxxxxx
```

```powershell
powershell -ExecutionPolicy Bypass -File .\FusionWebReader.ps1 -Probe -CookieFile .\cookies.txt
```

ข้อเสีย: คุกกี้หมดอายุแล้วต้องมาก๊อปใหม่ ใช้เป็นทางชั่วคราวระหว่างรอแก้ login

> ไฟล์ `cookies.txt` มีสิทธิ์เข้าบัญชีคุณ **อย่า commit ขึ้น git**

### 5. รันจริงแบบส่งเข้า Worker

ถ้ากรอก Worker URL กับ token ไว้ตอนขั้นที่ 2 แล้ว สั่งสั้น ๆ ได้เลย:

```powershell
powershell -ExecutionPolicy Bypass -File .\FusionWebReader.ps1
```

อ่านทุก 30 วินาที (แก้ด้วย `-IntervalSec`) ถ้า session หมดอายุจะ login ใหม่เอง
ถ้าพลาดติดกันจะค่อย ๆ ถ่างเวลาออกแต่ไม่เกิน 5 นาที

**ทำไมถึงควรถี่กว่า cron 5 นาทีของ Worker**: ค่าไฟคิดจากค่าเฉลี่ย 15 นาที
ยิ่งเก็บถี่ยิ่งรู้ตัวเร็วก่อนหน้าต่างจะปิด

### 6. ให้รันเองตอนเปิดเครื่อง (Task Scheduler)

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Task.ps1
```

สร้าง task ชื่อ `Solar Guard FusionSolar Reader` ให้เอง — เริ่มตอน logon,
ไม่มี timeout, ตายแล้วรีสตาร์ทเองทุก 5 นาที ไม่มีรหัสผ่านอยู่ในบรรทัดคำสั่งเลย
เพราะสคริปต์ไปอ่านจาก `fusion-cred.xml` ที่เข้ารหัสไว้

> task ต้องรันในนาม **user เดียวกับที่รัน Setup-Credentials.ps1** เพราะ DPAPI
> ผูกกับบัญชีนั้น — รันเป็น SYSTEM จะถอดรหัสไม่ได้

เริ่มเลยไม่ต้องรอ logon รอบหน้า:

```powershell
Start-ScheduledTask -TaskName "Solar Guard FusionSolar Reader"
Get-Content "$env:USERPROFILE\solar-guard-reader.log" -Tail 20 -Wait
```

ถอนออก:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Task.ps1 -Remove
```

---

## พารามิเตอร์

| พารามิเตอร์ | ค่าเริ่มต้น | ใช้ทำอะไร |
|---|---|---|
| `-Probe` | — | อ่านครั้งเดียว แสดงค่าดิบทั้งหมด ไม่ส่งไปไหน |
| `-SampleFile` | — | อ่านจากไฟล์ JSON แทนการต่อเน็ต (เทสต์ parser) |
| `-Once` | — | ส่งครั้งเดียวแล้วจบ (ใช้ตอนเรียกจาก cron ภายนอก) |
| `-IntervalSec` | 30 | อ่านทุกกี่วินาที |
| `-MeterSign` | 1 | `-1` ถ้าเครื่องหมายฝั่งการไฟฟ้ากลับด้าน |
| `-Station` | `NE=50174729` | รหัสโรงงาน (ดูได้จาก URL หน้า Overview) |
| `-Base` | `https://sg5.fusionsolar.huawei.com` | โซนเซิร์ฟเวอร์ |
| `-CookieFile` | — | ใช้คุกกี้แทน user/pass |
| `-CredentialFile` | `fusion-cred.xml` ข้างสคริปต์ | ที่เก็บรหัสแบบเข้ารหัส |
| `-LogFile` | — | เขียน log ลงไฟล์ด้วย |

---

## กับดักตอนตั้ง secret บน Cloudflare

**อย่าใช้ `$token | npx wrangler secret put NAME` บน PowerShell** — การไปป์แบบนี้
เติม newline ท้ายค่า ทำให้ค่าบน Cloudflare ไม่ตรงกับที่เก็บไว้ในเครื่อง
แล้วจะได้ 401 ที่หาสาเหตุยากมาก (เสียเวลาไล่มาแล้ว)

ใช้ `secret bulk` แทน ค่าจะตรงเป๊ะ:

```powershell
@{ INGEST_TOKEN = $token } | ConvertTo-Json -Compress | Set-Content secrets.json -Encoding ascii -NoNewline
npx wrangler secret bulk secrets.json
Remove-Item secrets.json
```

secret ใช้เวลา propagate ~10 วินาที ถ้าเทสต์ทันทีแล้วได้ 401 ให้รอแล้วลองใหม่ก่อนสรุปว่าพัง

---

## ขอบเขต

- สคริปต์นี้ **อ่านอย่างเดียว** ต่อ FusionSolar — มีแต่ GET ข้อมูล กับ POST ตอน login
  ไม่แตะการตั้งค่าใด ๆ ในพอร์ทัล
- ยังไม่มีค่า `dayPv` (พลังงานผลิตวันนี้) ส่งเข้า `/api/ingest` — ถ้าต้องการ
  ต้องดึงจาก `/rest/pvms/web/station/v1/overview/station-kpi-data` เพิ่ม
- `read_and_push.py` (Modbus) ยังเก็บไว้ ถ้าวันหนึ่งดีลเลอร์อัปเฟิร์มแวร์ให้แล้ว
  ทางนั้นดีกว่า: สดระดับวินาที และเน็ตนอกล่มก็ยังอ่านได้
