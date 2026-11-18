const USER_LIMIT_OPTIONS = [
  { value: 1, label: "۱ کاربره" },
  { value: 2, label: "۲ کاربره" },
  { value: 3, label: "۳ کاربره" },
  { value: 0, label: "بدون محدودیت" },
];

const PLAN_DEFINITIONS = [
  // One month
  { id: 1, months: 1, trafficGb: 10 },
  { id: 2, months: 1, trafficGb: 30 },
  { id: 3, months: 1, trafficGb: 50 },
  { id: 4, months: 1, trafficGb: 0, unlimited: true },

  // Two months
  { id: 5, months: 2, trafficGb: 50 },
  { id: 6, months: 2, trafficGb: 70 },
  { id: 7, months: 2, trafficGb: 100 },
  { id: 8, months: 2, trafficGb: 0, unlimited: true },

  // Three months
  { id: 9, months: 3, trafficGb: 100 },
  { id: 10, months: 3, trafficGb: 150 },
  { id: 11, months: 3, trafficGb: 200 },
  { id: 12, months: 3, trafficGb: 0, unlimited: true },
];

const COUNTRIES = [
  {
    code: "DE",
    name: "آلمان",
    flag: "🇩🇪",
    inboundId: Number(process.env.XUI_DE_INBOUND_ID),
  },
  {
    code: "NL",
    name: "هلند",
    flag: "🇳🇱",
    inboundId: Number(process.env.XUI_NL_INBOUND_ID),
  },
];

function calculatePrice({ trafficGb, months, unlimited = false }) {
  if (unlimited) {
    const unlimitedPrices = {
      1: 300000,
      2: 399000,
      3: 499000,
    };

    return unlimitedPrices[months];
  }

  return trafficGb * 7000 + months * 1000;
}

function formatTraffic(trafficGb, unlimited) {
  return unlimited ? "نامحدود" : `${trafficGb} گیگابایت`;
}

function formatDuration(months) {
  return `${months} ماهه`;
}

const products = COUNTRIES.flatMap((country) =>
  PLAN_DEFINITIONS.map((plan) => {
    const unlimited = Boolean(plan.unlimited);

    return {
      id: Number(`${country.code === "DE" ? 1 : 2}${plan.id}`),

      planId: plan.id,

      name: `${country.flag} VPN ${country.name}`,

      country: country.code,

      countryName: country.name,

      inboundId: country.inboundId,

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
module.exports.PLAN_DEFINITIONS = PLAN_DEFINITIONS;
module.exports.calculatePrice = calculatePrice;
