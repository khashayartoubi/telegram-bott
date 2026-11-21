// همهٔ گزینه‌های صفحهٔ شروع از اینجا کنترل می‌شوند.
// برای پنهان کردن یک گزینه، enabled را false کن؛ ترتیب آرایه همان ترتیب منو است.
const START_MENU = [
  { id: 'buy', label: '🛒 خرید کانفیگ', action: 'show_products', style: 'primary', enabled: true },
  { id: 'inquiry', label: '🔎 استعلام', action: 'inquiry', enabled: true },
  { id: 'wallet', label: '👛 کیف پول', action: 'wallet', enabled: true },
  { id: 'services', label: '🖥 سرویس‌های من', action: 'my_services', enabled: true },
  { id: 'orders', label: '🧾 سفارش‌های من', action: 'my_orders', enabled: true },
  { id: 'tutorials', label: '🎬 آموزش اتصال', action: 'connection_tutorials', enabled: true },
  { id: 'support', label: '💬 پشتیبانی', action: 'support', enabled: true },
  { id: 'trial', label: '🎁 اکانت تست رایگان', action: 'claim_trial', style: 'success', enabled: true },
];

// کدهای تخفیف: amount مبلغِ تومان و percent درصد تخفیف است.
// productIds خالی یعنی کد روی همهٔ پلن‌ها فعال است. شناسهٔ هر پلن در catalog.js است.
const DISCOUNT_CODES = [
  // { code: 'WELCOME10', type: 'percent', value: 10, productIds: [], enabled: true },
  // { code: 'NL50000', type: 'amount', value: 50_000, productIds: [21, 22], enabled: true },
];

// لینک ویدیوی آموزش را وارد و enabled را true کن؛ هر تعداد مورد می‌توانی اضافه کنی.
const CONNECTION_TUTORIALS = [
  // { title: '🎬 آموزش اتصال با V2Box', url: 'https://example.com/v2box-video', enabled: true },
  // { title: '🎬 آموزش اتصال با HAPP', url: 'https://example.com/happ-video', enabled: true },
];

const REQUIRED_CHANNEL = {
  enabled: true,
  chatId: process.env.REQUIRED_CHANNEL_ID,
  joinUrl: 'https://t.me/+9AIDlPT1CmBkNmRk',
};

const SUPPORT = {
  chatId: process.env.SUPPORT_CHAT_ID,
  directUrl: 'https://t.me/MRSERVER_SELLER',
};

const MAX_SERVICE_PROFILES = 3;

const TRIAL_ACCOUNT = {
  enabled: true,
  // برای ریست تست همهٔ کاربران، این عدد را افزایش بده (مثلاً 2).
  campaignId: 1,
  // برای انتقال اکانت تست به آلمان فقط مقدار را به 'DE' تغییر بده.
  countryCode: 'NL',
  // 100 MiB (3x-ui totalGB is stored in bytes).
  trafficGb: 100 / 1024,
  trafficLabel: '۱۰۰ مگابایت',
  durationDays: 1,
  limitIp: 1,
  usernamePrefix: 'trial',
};

module.exports = {
  START_MENU,
  TRIAL_ACCOUNT,
  DISCOUNT_CODES,
  CONNECTION_TUTORIALS,
  REQUIRED_CHANNEL,
  SUPPORT,
  MAX_SERVICE_PROFILES,
};
