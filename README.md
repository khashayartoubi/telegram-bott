# Telegram VPN Bot

## تنظیمات روزمره

- قیمت، پلن‌ها، کشورها و تعداد کاربران در [src/config/catalog.js](src/config/catalog.js) قرار دارند.
- متن‌های کوتاه و قابل‌تغییر رابط کاربر در [src/config/texts.js](src/config/texts.js) هستند.
- برای افزودن کشور، یک مورد به `COUNTRIES` اضافه کن و متغیر `XUI_<COUNTRY>_INBOUND_ID` را در `.env` بگذار. نمونهٔ فرانسه در همان فایل کامنت شده است.
- برای افزودن حالت ۴ کاربره، یک مورد به `USER_LIMIT_OPTIONS` اضافه کن؛ دکمه و محاسبهٔ مبلغ خودکار ساخته می‌شود.
- ویدیوی آموزش V2Box را با پسوند `mp4`، `mov`، `mkv` یا `webm` داخل پوشهٔ `video/` قرار بده. اگر پوشه ویدیو نداشته باشد، ربات بدون خطا از ارسال آن عبور می‌کند.
- `XUI_SUBSCRIPTION_BASE_URL` باید دقیقاً پیشوند URL عمومی Subscription باشد که خود 3x-ui در بخش **Subscription info** نمایش/کپی می‌کند؛ شامل مسیر و اسلش پایانی، اما بدون `subId`. مسیر این پنل ممکن است تصادفی یا سفارشی باشد و لزوماً `/sub/` نیست. برای نمونه اگر پنل لینک `https://example.com/AbCd123/<subId>` می‌دهد، مقدار متغیر `https://example.com/AbCd123/` است. ربات `subId` هر کاربر را به انتهای این URL اضافه می‌کند و QR همان لینک را می‌فرستد. در صورت نیاز به قالب خاص، از `{subId}` استفاده کن؛ مثل `https://example.com/path/{subId}`. لینک VLESS مستقیم میزان مصرف را نشان نمی‌دهد؛ V2Box این اطلاعات را فقط از هدر `Subscription-Userinfo` در لینک subscription دریافت می‌کند.
- نامی که V2Box پس از افزودن Subscription نشان می‌دهد از فیلد **Remark** همان Inbound در 3x-ui می‌آید. برای هلند، Remark را مثلاً `vpanet NL 🇳🇱` بگذار؛ سپس همهٔ کانفیگ‌های Subscription همان نام را خواهند داشت.
- متن شروع، منو، فعال/غیرفعال بودن آیتم‌ها و تنظیمات اکانت تست در [src/config/features.js](src/config/features.js) قرار دارد. اکانت تست برای هر شناسهٔ تلگرام فقط یک‌بار صادر می‌شود.
- اکانت تست هیچ مرحلهٔ انتخابی ندارد: ۱ روز، ۱۰۰ مگابایت، یک کاربر و کشور آن از `TRIAL_ACCOUNT.countryCode` تعیین می‌شود (فعلاً `NL`).
- کدهای تخفیف، محدودیت سه Username، لینک‌های آموزش و تنظیمات پشتیبانی در [src/config/features.js](src/config/features.js) هستند. `productIds: []` در کد تخفیف یعنی قابل استفاده برای تمام پلن‌ها.
- برای اجباری‌کردن عضویت کانال، `REQUIRED_CHANNEL_ID` و برای دریافت پیام‌های پشتیبانی `SUPPORT_CHAT_ID` را در `.env` تنظیم کن. بات باید عضو/ادمین مقصدهای مربوط باشد.

برای نصب وابستگی‌ها و اجرا:

```bash
npm install
npm start
```

## اجرا با PM2 در توسعه

```bash
npm run dev
npm run dev:logs
npm run dev:restart
npm run dev:stop
```

`npm run dev` بات را با نام `telegram-bot-dev` و watch mode اجرا می‌کند. برای اجرای ساده با nodemon نیز `npm run dev:nodemon` در دسترس است.

## Docker

ابتدا فایل `.env` را از روی `.env.example` بساز و مقادیر واقعی را وارد کن، سپس:

```bash
docker compose up -d --build
docker compose logs -f telegram-bot
docker compose down
```

دیتابیس SQLite در volume به نام `telegram-bot-data` نگهداری می‌شود و با بازسازی کانتینر از بین نمی‌رود.

لاگ Docker با driver محلی و حداکثر سه فایل چرخشی محدود شده است. برای حذف دقیق لاگ‌های قدیمی‌تر از سه روز در سطح سرور، برای Docker host یک job روزانهٔ logrotate یا پاک‌سازی تنظیم کن؛ Compose به‌تنهایی سیاست زمانی برای لاگ daemon ندارد.
