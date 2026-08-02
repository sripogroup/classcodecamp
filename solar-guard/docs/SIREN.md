# ไฟหมุน / ไซเรน — เริ่มจากของฟรีก่อน แล้วค่อยซื้อของ

ตอนนี้ยังไม่มีไฟหมุนหรือลำโพงในโรงงาน ไม่เป็นไร แผนคือทำเป็น 3 ขั้น ใช้ขั้นที่ 1 ไปก่อนได้เลยวันนี้

---

## ขั้นที่ 1 — ใช้ของที่มีอยู่แล้ว (ฟรี ทำได้วันนี้)

เอา **คอมเครื่องเก่า / แท็บเล็ตเก่า / สมาร์ททีวี** เครื่องไหนก็ได้ เปิดหน้า dashboard ค้างไว้ที่จุดที่คนเดินผ่านบ่อย (หน้าออฟฟิศ / ห้องคุมเครื่อง / โรงอาหาร)

หน้านั้นทำสองอย่างให้อยู่แล้ว:

1. **ไฟสามสีเต็มจอ** เขียว/เหลือง/แดง เห็นจากไกล ๆ ไม่ต้องอ่านตัวเลข ตอนแดงจะกะพริบด้วย
2. **เสียงไซเรนออกลำโพงเครื่องนั้นเลย** — กดปุ่ม `🔇 เปิดเสียงเตือน` มุมล่างขวาครั้งเดียว (เบราว์เซอร์บังคับให้คนกดก่อน ถึงจะเล่นเสียงได้) หลังจากนั้นพอเป็นสีแดงจะมีเสียงไซเรนดังทุก 4 วินาทีจนกว่าจะกลับเป็นปกติ

เคล็ดลับ:
- ตั้งเบราว์เซอร์เป็น kiosk mode จะได้ไม่มีใครเผลอปิด
  `chromium --kiosk --app=https://solar-guard.<ชื่อบัญชี>.workers.dev/?k=TOKEN`
- ปิด screensaver / sleep ของเครื่อง
- ถ้าโรงงานเสียงดังมาก ต่อลำโพงคอมพิวเตอร์ตัวละ 300 บาท เข้าช่องหูฟังก็พอ

**ควรใช้ขั้นนี้อย่างน้อย 1 เดือน** ก่อนซื้อไฟหมุน เพื่อดูก่อนว่าเกณฑ์สีแดงที่ตั้งไว้แม่นแล้วจริง ๆ ไม่งั้นไฟหมุนจะหมุนวันละ 10 รอบแล้วโดนถอดปลั๊กภายในสัปดาห์เดียว

---

## ขั้นที่ 2 — ไฟหมุน + ไซเรนของจริง (~700–1,200 บาท)

### ของที่ต้องซื้อ

| ของ | ราคาโดยประมาณ |
|---|---|
| ESP32 DevKit V1 | 150–250 บาท |
| โมดูลรีเลย์ 1 ช่อง (แบบ opto-isolated) | 40–80 บาท |
| ไฟหมุน LED + ไซเรน 220V (แบบที่ใช้ในโรงงาน) | 350–700 บาท |
| อะแดปเตอร์ 5V + กล่องพลาสติก + สายไฟ | 150 บาท |

ระบบไม่ต้องมีเซิร์ฟเวอร์เพิ่ม — ESP32 ต่อ WiFi แล้วถาม Cloudflare เองทุก 30 วินาทีว่า `siren` เป็น `true` ไหม

> ⚠️ ส่วนที่เป็นไฟ 220V ให้ช่างไฟฟ้าของโรงงานเป็นคนต่อ อย่าต่อเอง

### API ที่ ESP32 เรียก

```
GET https://solar-guard.<ชื่อบัญชี>.workers.dev/api/state?k=TOKEN
```

ตอบกลับมาแบบนี้ (ตัดมาเฉพาะที่ใช้):

```json
{
  "level": "red",
  "siren": true,
  "stale": false,
  "gridImportKw": 36.0
}
```

ให้ดูที่ `siren` อย่างเดียวพอ — `true` เมื่อสถานะแดงและข้อมูลยังสด (ถ้าระบบดึงข้อมูลไม่ได้ `stale` จะเป็น `true` และ `siren` จะเป็น `false` ไฟหมุนจะไม่หมุนมั่ว)

### โค้ด ESP32 (Arduino IDE)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* SSID     = "ชื่อWiFiโรงงาน";
const char* PASSWORD = "รหัสWiFi";
const char* URL      = "https://solar-guard.xxxx.workers.dev/api/state?k=TOKEN";

const int RELAY_PIN   = 26;   // ขาที่ต่อเข้าโมดูลรีเลย์
const int POLL_MS     = 30000;
const int MAX_ON_MIN  = 15;   // หมุนต่อเนื่องนานสุด 15 นาที แล้วหยุดเอง (กันหนวกหู)

unsigned long sirenStartedAt = 0;
bool sirenOn = false;

void setSiren(bool on) {
  if (on == sirenOn) return;
  sirenOn = on;
  digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  if (on) sirenStartedAt = millis();
}

void setup() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  Serial.begin(115200);
  WiFi.begin(SSID, PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi ต่อแล้ว");
}

void loop() {
  // ถึงเวลาสูงสุดแล้วให้ดับเอง แม้สถานะยังแดงอยู่
  if (sirenOn && millis() - sirenStartedAt > (unsigned long)MAX_ON_MIN * 60000UL) {
    setSiren(false);
  }

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(URL);
    http.setTimeout(8000);
    int code = http.GET();
    if (code == 200) {
      String body = http.getString();
      bool wantSiren = body.indexOf("\"siren\": true") >= 0 || body.indexOf("\"siren\":true") >= 0;
      // สั่งหมุนใหม่เฉพาะตอนที่เพิ่งเปลี่ยนเป็นแดง
      if (wantSiren && !sirenOn && millis() - sirenStartedAt > (unsigned long)MAX_ON_MIN * 60000UL) setSiren(true);
      if (wantSiren && sirenStartedAt == 0) setSiren(true);
      if (!wantSiren) { setSiren(false); sirenStartedAt = 0; }
      Serial.printf("siren=%d\n", wantSiren);
    } else {
      Serial.printf("เรียก API ไม่สำเร็จ: %d\n", code);
      // เรียกไม่ได้ = ไม่หมุน ปลอดภัยกว่าหมุนมั่ว
      setSiren(false);
    }
    http.end();
  }
  delay(POLL_MS);
}
```

> ถ้าไม่อยากเขียนโค้ดเลย ใช้ **Shelly Plus 1** (ประมาณ 700 บาท) แทน ESP32 ได้ มันมีระบบ script ในตัว เขียน JavaScript สั้น ๆ ให้ยิง `Shelly.call("HTTP.GET", ...)` ทุก 30 วินาทีแล้วสั่งรีเลย์ตาม `siren` เหมือนกัน แต่ไม่ต้องบัดกรีอะไรเลย

---

## ขั้นที่ 3 — ไฟหมุนสามสีติดถาวร (ทำเมื่อระบบนิ่งแล้ว)

เปลี่ยนจากไฟหมุนสีเดียวเป็น **tower light 3 สี** (เขียว/เหลือง/แดง) ใช้รีเลย์ 3 ช่อง แล้วให้ ESP32 อ่าน `level` แทน `siren`:

- `"green"` → ไฟเขียวติด (บอกว่าระบบยังทำงานอยู่ ไม่ใช่ไฟดับ)
- `"yellow"` → ไฟเหลืองติด ไม่มีเสียง
- `"red"` → ไฟแดง + เสียงไซเรน
- `"unknown"` / `stale: true` → ไฟทั้งสามกะพริบช้า ๆ หรือดับหมด = ระบบเฝ้าให้ไม่ได้ ต้องแจ้งไอที

ข้อดีของ 3 สีคือ **ไฟเขียวที่ติดอยู่ตลอดคือหลักฐานว่าระบบยังทำงาน** ถ้าใช้ไฟแดงอย่างเดียว วันที่ระบบพัง ไฟก็ดับเหมือนวันปกติ แล้วไม่มีใครรู้
