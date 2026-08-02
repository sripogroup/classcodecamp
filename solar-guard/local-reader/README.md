# ตัวอ่านค่าในโรงงาน — ทางลัดที่ไม่ต้องรอดีลเลอร์

## ทำไมต้องมี

บัญชี FusionSolar ที่ใช้อยู่เป็นระดับ**เจ้าของโรงงาน** ซึ่งไม่มีเมนู Northbound Management
(ตรวจแล้วในเมนู System มีแค่ Personal Settings / About / Service Settings)
แปลว่า**สร้างบัญชี API เองไม่ได้ ต้องขอจากดีลเลอร์**

ตัวอ่านนี้เป็นทางเลือกที่ข้ามเรื่องนั้นไปเลย — อ่านจากอินเวอร์เตอร์ตรง ๆ ในวง LAN

| | ผ่านคลาวด์ Huawei | **อ่านเองในโรงงาน** |
|---|---|---|
| ต้องขอบัญชีจากดีลเลอร์ | ✅ ต้อง | ❌ ไม่ต้อง |
| ความสดของข้อมูล | ช้า 5–10 นาที | **ระดับวินาที** |
| จำกัดจำนวนครั้งที่เรียก | ✅ มี (ห้ามถี่กว่า 5 นาที) | ❌ ไม่มี |
| เน็ตนอกล่ม | อ่านไม่ได้เลย | ยังอ่านได้ (แค่ส่งออกไม่ได้) |
| ต้องมีเครื่องเปิดค้างในโรงงาน | ไม่ต้อง | ✅ ต้อง |

ความสดของข้อมูลสำคัญมากกับงานนี้ เพราะหน้าต่างที่ต้องป้องกันยาวแค่ 15 นาที
ถ้าข้อมูลช้า 10 นาที กว่าจะรู้ตัวก็เหลือเวลาแก้ไม่กี่นาที
(อ่านรายละเอียดที่ `../docs/AUTOSHED.md` หัวข้อ 2)

---

## สิ่งที่ต้องมี

1. **เครื่องอะไรก็ได้ที่เปิดค้างไว้ และอยู่วง LAN เดียวกับอินเวอร์เตอร์**
   คอมเก่า / Raspberry Pi / มินิพีซี / เซิร์ฟเวอร์ที่มีอยู่แล้วก็ได้

   > ⚠️ **ต้องอยู่ที่โรงงาน** — ถ้าเครื่องอยู่คนละที่กับอินเวอร์เตอร์ จะต่อไม่ถึง
   > กินทรัพยากรน้อยมาก (สคริปต์ Python ตัวเดียว ทำงานทุก 30 วินาที) ไม่ใช่ service หนัก ๆ

2. **Python 3** และไลบรารีตัวเดียว
   ```bash
   pip install pymodbus
   ```

3. **เปิด Modbus TCP ที่อินเวอร์เตอร์**
   ตั้งในแอพ FusionSolar ที่ Device → เลือกอินเวอร์เตอร์ → Settings → Communication
   หรือให้ช่างที่ติดตั้งเปิดให้ (ปกติใช้พอร์ต 502)

---

## ขั้นตอน

### 1) หา IP ของอินเวอร์เตอร์

ดูในแอพ FusionSolar ที่หน้า Device หรือดูในหน้า admin ของเราเตอร์
มองหาอุปกรณ์ชื่อขึ้นต้นด้วย `SUN2000` หรือ `Huawei`

### 2) ทดสอบอ่านค่าก่อน (ยังไม่ส่งไปไหน)

```bash
python read_and_push.py --host 192.168.1.50 --probe
```

จะได้ผลประมาณนี้:

```
  pv_active_power        (reg 32080) = 11.884 kW
  meter_active_power     (reg 37113) = 1.902 kW
  meter_status           (reg 37100) = 1
  daily_yield            (reg 32114) = 128.46 kWh

  โหลดรวมที่คำนวณได้ = 13.79 kW
```

**⚠️ ขั้นตอนนี้ห้ามข้าม** — เอาตัวเลขที่ได้ไปเทียบกับหน้า Overview ในแอพ FusionSolar:

| ค่าที่อ่านได้ | ต้องตรงกับในแอพ |
|---|---|
| `pv_active_power` | Output power ฝั่ง PV |
| `meter_active_power` | Current power ฝั่ง Grid |
| ผลรวม | Consumed by appliances (Load) |

- ถ้าตรงกัน → ไปต่อได้
- ถ้า**เครื่องหมายกลับกัน** (ตอนซื้อไฟได้ค่าติดลบ) → ใส่ `--meter-sign -1`
- ถ้า**ตัวเลขไม่ตรงเลย** → เลข register ของรุ่นคุณอาจต่างไป ส่งผลลัพธ์มาให้ช่วยดูได้

### 3) รันจริง

```bash
python read_and_push.py \
  --host 192.168.1.50 \
  --url https://solar-guard.xxxx.workers.dev \
  --token รหัสที่ตั้งไว้ใน_INGEST_TOKEN \
  --interval 30
```

ฝั่ง Cloudflare ต้องตั้งด้วย:

```bash
npx wrangler secret put INGEST_TOKEN     # ตั้งรหัสยาว ๆ
```

> ⚠️ **รหัสต้องเป็นตัวอักษรอังกฤษ ตัวเลข หรือขีดเท่านั้น ห้ามใช้ภาษาไทย**
> เพราะมันถูกส่งไปใน HTTP header ซึ่งรองรับแค่อักขระ ASCII
> เช่น `sripo-solar-2569-x7k2m` ใช้ได้ แต่ `รหัสลับ` จะส่งไม่ออกเลย

แล้วแก้ใน `wrangler.toml`:

```toml
DATA_SOURCE = "push"
```

### 4) ให้มันรันค้างไว้

**Windows** — Task Scheduler → Create Task → Triggers: At startup → Actions:
```
Program:   C:\Python3\python.exe
Arguments: C:\solar-guard\local-reader\read_and_push.py --host 192.168.1.50 --url https://... --token ...
```
ติ๊ก "Run whether user is logged on or not" และตั้ง Restart on failure

**Linux (systemd)** — สร้างไฟล์ `/etc/systemd/system/solar-reader.service`:

```ini
[Unit]
Description=Solar Guard local reader
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/solar-guard/local-reader/read_and_push.py \
  --host 192.168.1.50 --url https://solar-guard.xxxx.workers.dev --token XXXX
Restart=always
RestartSec=30
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now solar-reader
sudo journalctl -u solar-reader -f      # ดู log
```

---

## ระบบจะรู้เองถ้าตัวอ่านตาย

ถ้าไม่มีข้อมูลเข้ามาเกิน 20 นาที ระบบจะส่งข้อความเข้ากลุ่ม Telegram ว่า
*"ตัวอ่านในโรงงานหยุดส่งข้อมูล"* พร้อมบอกให้ไปเช็คไฟ / WiFi / สาย RS485

ตรงนี้สำคัญ — **"เงียบ" ต้องไม่ถูกตีความว่า "ปกติ"** ถ้าตัวอ่านตายแล้วไม่มีใครรู้
ทุกคนจะเข้าใจผิดว่ายังปลอดภัยอยู่ ทั้งที่ไม่มีใครเฝ้าให้แล้ว

---

## ถ้าได้บัญชี Northbound API จากดีลเลอร์ทีหลัง

ใช้ทั้งสองทางพร้อมกันได้ หรือสลับกลับไปใช้ API ก็ได้ แค่เปลี่ยน `DATA_SOURCE` กลับเป็น `"api"`
ตรรกะการเตือนทั้งหมดเหมือนกันหมด ไม่ต้องแก้อะไรอีก

แต่ถึงได้บัญชีมาแล้ว **ตัวอ่านในโรงงานก็ยังคุ้มที่จะรันต่อ** เพราะข้อมูลสดกว่ามาก
ซึ่งเป็นข้อจำกัดใหญ่ที่สุดของการดึงผ่านคลาวด์
