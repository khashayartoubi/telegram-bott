# Telegram VPN Bot

## تنظیمات روزمره

- قیمت، پلن‌ها، کشورها و تعداد کاربران در [src/config/catalog.js](src/config/catalog.js) قرار دارند.
- متن‌های کوتاه و قابل‌تغییر رابط کاربر در [src/config/texts.js](src/config/texts.js) هستند.
- برای افزودن کشور، یک مورد به `COUNTRIES` اضافه کن و متغیر `XUI_<COUNTRY>_INBOUND_ID` را در `.env` بگذار. نمونهٔ فرانسه در همان فایل کامنت شده است.
- برای افزودن حالت ۴ کاربره، یک مورد به `USER_LIMIT_OPTIONS` اضافه کن؛ دکمه و محاسبهٔ مبلغ خودکار ساخته می‌شود.
- ویدیوی آموزش V2Box را با پسوند `mp4`، `mov`، `mkv` یا `webm` داخل پوشهٔ `video/` قرار بده. اگر پوشه ویدیو نداشته باشد، ربات بدون خطا از ارسال آن عبور می‌کند.
- `XUI_SUBSCRIPTION_BASE_URL` باید URL معتبرِ سرویس subscription و تنها با **یک پورت** باشد؛ مانند `http://server:2096/your-path/`. لینک VLESS مستقیم میزان مصرف را نشان نمی‌دهد؛ V2Box این اطلاعات را فقط از هدر `Subscription-Userinfo` در لینک subscription دریافت می‌کند.
- متن شروع، منو، فعال/غیرفعال بودن آیتم‌ها و تنظیمات اکانت تست در [src/config/features.js](src/config/features.js) قرار دارد. اکانت تست برای هر شناسهٔ تلگرام فقط یک‌بار صادر می‌شود.

برای نصب وابستگی‌ها و اجرا:

```bash
npm install
npm start
```
