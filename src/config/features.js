// همهٔ گزینه‌های صفحهٔ شروع از اینجا کنترل می‌شوند.
// برای پنهان کردن یک گزینه، enabled را false کن؛ ترتیب آرایه همان ترتیب منو است.
function optionalTelegramChatId(value) {
  const chatId = String(value || '').trim();
  // A public channel username is valid for getChatMember as well as a numeric
  // channel ID. Private channels must still use their -100... ID.
  return /^-?\d+$/.test(chatId) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(chatId) ? chatId : '';
}

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
  // شناسهٔ عددی کانال خصوصی یا @username کانال عمومی. اگر تنظیم نشود، بررسی عضویت غیرفعال است.
  chatId: optionalTelegramChatId(process.env.REQUIRED_CHANNEL_ID),
  joinUrl: process.env.REQUIRED_CHANNEL_URL?.trim() || 'https://t.me/vpanetCO',
};
REQUIRED_CHANNEL.enabled = Boolean(REQUIRED_CHANNEL.chatId);

const SUPPORT = {
  // مقدار خالی یا نمونهٔ -100...، ارسال داخلی را غیرفعال می‌کند.
  chatId: optionalTelegramChatId(process.env.SUPPORT_CHAT_ID),
  directUrl: 'https://t.me/+9AIDlPT1CmBkNmRk',
};

// سقف پروفایل‌های یکتا برای هر کاربر. سفارش‌های قدیمی نیز به‌عنوان پروفایل
// مهاجرت می‌شوند، بنابراین مقدار بسیار کوچک جلوی ساخت Username جدید را می‌گیرد.
const MAX_SERVICE_PROFILES = 10;

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
