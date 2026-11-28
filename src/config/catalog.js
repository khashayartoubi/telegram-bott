const USER_LIMIT_OPTIONS = [
  { value: 1, label: "۱ کاربره", extraPrice: 0 },
  { value: 2, label: "۲ کاربره", extraPrice: 50_000 },
  { value: 3, label: "۳ کاربره", extraPrice: 75_000 },
  // برای افزودن حالت ۴ کاربره فقط این خط را اضافه کنید.
  // { value: 4, label: "۴ کاربره", extraPrice: 100_000 },
  { value: 0, label: "بدون محدودیت", extraPrice: 120_000 },
];

const PLAN_DEFINITIONS = [
  // One month
  { id: 1, months: 1, trafficGb: 10 },
  { id: 2, months: 1, trafficGb: 30 },
  { id: 3, months: 1, trafficGb: 50 },
  // { id: 4, months: 1, trafficGb: 0, unlimited: true },

  // Two months
  { id: 5, months: 2, trafficGb: 50 },
  { id: 6, months: 2, trafficGb: 70 },
  { id: 7, months: 2, trafficGb: 100 },
  // { id: 8, months: 2, trafficGb: 0, unlimited: true },

  // Three months
  { id: 9, months: 3, trafficGb: 100 },
  { id: 10, months: 3, trafficGb: 150 },
  { id: 11, months: 3, trafficGb: 200 },
  // { id: 12, months: 3, trafficGb: 0, unlimited: true },
];

// تمام قیمت‌ها اینجا متمرکز هستند.
const PRICING = {
  pricePerGb: 7_000,
  pricePerMonth: 1_000,
  unlimitedByMonth: {
    1: 400_000,
    2: 759_000,
    3: 1_499_000,
  },
};

// مقدارهای قدیمی تک-ID و آرایهٔ JSON مانند `[2,3,4]` هر دو پذیرفته می‌شوند.
// ترتیب آرایه مهم است: اولین ID باید inbound اصلی VLESS باشد.
function parseInboundIds(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    values = raw.split(',');
  }

  if (!Array.isArray(values)) values = [values];
  return [...new Set(values.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

const DE_INBOUND_IDS = parseInboundIds(process.env.XUI_DE_INBOUND_ID);
const NL_INBOUND_IDS = parseInboundIds(process.env.XUI_NL_INBOUND_ID);
const CA_INBOUND_IDS = parseInboundIds(process.env.XUI_CA_INBOUND_ID);
const FR_INBOUND_IDS = parseInboundIds(process.env.XUI_FR_INBOUND_ID);

const COUNTRIES = [
  {
    code: "DE",
    name: "آلمان",
    flag: "🇩🇪",
    inboundId: DE_INBOUND_IDS[0],
    inboundIds: DE_INBOUND_IDS,
    // show نمایش کشور و enabled امکان خرید آن را کنترل می‌کند.
    show: true,
    enabled: false,
  },
  {
    code: "NL",
    name: "هلند",
    flag: "🇳🇱",
    inboundId: NL_INBOUND_IDS[0],
    inboundIds: NL_INBOUND_IDS,
    show: true,
    enabled: true,
  },
  {
    code: "CA",
    name: "کانادا",
    flag: "🇨🇦",
    inboundId: CA_INBOUND_IDS[0],
    inboundIds: CA_INBOUND_IDS,
    show: true,
    enabled: false,
  },
  {
    code: "FR",
    name: "فرانسه",
    flag: "🇫🇷",
    inboundId: FR_INBOUND_IDS[0],
    inboundIds: FR_INBOUND_IDS,
    show: true,
    enabled: false,
  },
];

function calculatePrice({ trafficGb, months, unlimited = false }) {
  if (unlimited) {
    return PRICING.unlimitedByMonth[months];
  }

  return trafficGb * PRICING.pricePerGb + months * PRICING.pricePerMonth;
}

function formatTraffic(trafficGb, unlimited) {
  return unlimited ? "نامحدود" : `${trafficGb} گیگابایت`;
}

function formatDuration(months) {
  return `${months} ماهه`;
}

const products = COUNTRIES.flatMap((country, countryIndex) =>
  PLAN_DEFINITIONS.map((plan) => {
    const unlimited = Boolean(plan.unlimited);

    return {
      // شناسهٔ عددی پایدار برای سازگاری با سفارش‌های قبلی دیتابیس.
      id: Number(`${countryIndex + 1}${plan.id}`),

      planId: plan.id,

      name: `${country.flag} VPN ${country.name}`,

      country: country.code,

      countryName: country.name,

      inboundId: country.inboundId,

      inboundIds: country.inboundIds,

      show: country.show === true,

      enabled: country.enabled !== false,

      months: plan.months,

      duration: formatDuration(plan.months),

      durationDays: plan.months * 30,

      trafficGb: plan.trafficGb,

      unlimited,

      trafficLabel: formatTraffic(plan.trafficGb, unlimited),

      price: calculatePrice(plan),

      description: `سرویس VPN ${country.name} با حجم ${formatTraffic(
        plan.trafficGb,
        unlimited,
      )} و مدت ${formatDuration(plan.months)}`,

      features: [
        formatTraffic(plan.trafficGb, unlimited),
        formatDuration(plan.months),
        "قابلیت انتخاب تعداد کاربران",
      ],
    };
  }),
);

module.exports = products;

module.exports.USER_LIMIT_OPTIONS = USER_LIMIT_OPTIONS;
module.exports.COUNTRIES = COUNTRIES;
module.exports.PLAN_DEFINITIONS = PLAN_DEFINITIONS;
module.exports.PRICING = PRICING;
module.exports.calculatePrice = calculatePrice;
module.exports.isCountryEnabled = (countryCode) =>
  COUNTRIES.some(
    (country) => country.code === countryCode && country.enabled !== false,
  );
module.exports.isCountryVisible = (countryCode) =>
  COUNTRIES.some(
    (country) => country.code === countryCode && country.show === true,
  );
