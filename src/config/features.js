// همهٔ گزینه‌های صفحهٔ شروع از اینجا کنترل می‌شوند.
// برای پنهان کردن یک گزینه، enabled را false کن؛ ترتیب آرایه همان ترتیب منو است.
const START_MENU = [
  { id: 'buy', label: '🛒 خرید کانفیگ', action: 'show_products', style: 'primary', enabled: true },
  { id: 'inquiry', label: '🔎 استعلام', action: 'inquiry', enabled: true },
  { id: 'wallet', label: '👛 کیف پول', action: 'wallet', enabled: true },
  { id: 'services', label: '🖥 سرویس‌های من', action: 'my_services', enabled: true },
  { id: 'orders', label: '🧾 سفارش‌های من', action: 'my_orders', enabled: true },
  { id: 'trial', label: '🎁 اکانت تست رایگان', action: 'claim_trial', style: 'success', enabled: true },
];

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

module.exports = { START_MENU, TRIAL_ACCOUNT };
