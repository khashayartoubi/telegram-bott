require('dotenv').config();

const crypto = require('crypto');
const { Telegraf, Markup, session } = require('telegraf');

const products = require('./data/products');

const {
  createOrder,
  getOrder,
  getUserOrders,
  updateOrder,
  getPendingOrders,
  isUsernameTaken,
  submitPaymentReceipt,
  approvePayment,
  rejectPayment,
  claimProvision,
  cancelUnpaidOrder,
  getUserProfiles,
  getDefaultProfile,
  getUserProfile,
  saveServiceProfile,
} = require('./database/db');

const { provisionClient } = require('./services/xui.service');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is missing');
}

if (!Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  throw new Error('ADMIN_TELEGRAM_ID is missing or invalid');
}

const bot = new Telegraf(BOT_TOKEN);

bot.use(
  session({
    getSessionKey: (ctx) => ctx.from?.id?.toString(),
  }),
);

bot.use(async (ctx, next) => {
  if (!ctx.session) ctx.session = {};
  await next();
});

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function formatPrice(price) {
  return `${Number(price).toLocaleString('fa-IR')} تومان`;
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🛒 خرید سرویس VPN', 'show_products')],
    [Markup.button.callback('📦 سفارش‌های من', 'my_orders')],
    [Markup.button.callback('📞 پشتیبانی', 'support')],
  ]);
}

function getProduct(productId) {
  return products.find((product) => product.id === Number(productId));
}

function getProductByInbound(inboundId) {
  return products.find((product) => Number(product.inboundId) === Number(inboundId));
}

function getUserLimitLabel(limitIp) {
  const labels = {
    1: '۱ کاربر',
    2: '۲ کاربر',
    3: '۳ کاربر',
    0: 'بدون محدودیت',
  };

  return labels[Number(limitIp)] || 'نامشخص';
}

// قیمت اضافه بر اساس تعداد کاربران
function getPriceExtra(limitIp) {
  const extraPrices = {
    1: 0,
    2: 50_000,
    3: 75_000,
    0: 120_000,
  };

  const extra = extraPrices[Number(limitIp)];

  if (extra === undefined) {
    throw new Error(`Invalid limitIp: ${limitIp}`);
  }

  return extra;
}

// محاسبه قیمت نهایی محصول
function calculateProductPrice(basePrice, limitIp) {
  const base = Number(basePrice);

  if (!Number.isFinite(base) || base < 0) {
    throw new Error(`Invalid base price: ${basePrice}`);
  }

  return base + getPriceExtra(limitIp);
}

function createUsername() {
  return crypto.randomUUID();
}

function isValidUsername(username) {
  return /^[a-zA-Z0-9_-]{3,32}$/.test(username);
}

function clearPurchase(ctx) {
  if (ctx.session) {
    delete ctx.session.purchase;
  }
}

function getStatusLabel(status) {
  const labels = {
    awaiting_payment: 'در انتظار پرداخت',
    payment_review: 'در انتظار بررسی رسید',
    processing: 'در حال ساخت سرویس',
    active: 'سرویس فعال',
    rejected: 'رسید رد شده',
    failed: 'خطا در ساخت سرویس',
    cancelled: 'لغوشده',
  };

  return labels[status] || status;
}

function getSelectedServerInfo(purchase) {
  const product = getProduct(purchase.productId);

  if (!product) return null;

  if (purchase.profileInboundId) {
    const oldServerProduct = getProductByInbound(purchase.profileInboundId);

    if (oldServerProduct) {
      return {
        country: oldServerProduct.country,
        countryName: oldServerProduct.countryName,
        inboundId: Number(purchase.profileInboundId),
      };
    }

    return {
      country: product.country,
      countryName: product.countryName,
      inboundId: Number(purchase.profileInboundId),
    };
  }

  return {
    country: product.country,
    countryName: product.countryName,
    inboundId: Number(product.inboundId),
  };
}

// --------------------------------------------------
// Username selection
// --------------------------------------------------

async function showUsernameOptions(ctx) {
  const purchase = ctx.session.purchase;

  if (!purchase) {
    return ctx.reply('فرایند خرید پیدا نشد. دوباره از منوی اصلی شروع کن.');
  }

  const profiles = getUserProfiles(ctx.from.id);

  purchase.step = 'choose_username';

  const buttons = [];

  if (profiles.length) {
    for (const profile of profiles) {
      const defaultLabel = profile.is_default ? ' ⭐ پیش‌فرض' : '';

      buttons.push([Markup.button.callback(`🔄 ${profile.xui_email}${defaultLabel}`, `profile_use_${profile.xui_email}`)]);
    }

    buttons.push([Markup.button.callback('➕ ساخت Username جدید', 'username_new')]);

    await ctx.reply(
      `👤 انتخاب Username سرویس\n\n` +
        `می‌توانی از یکی از Usernameهای قبلی استفاده کنی یا یک Username جدید بسازی.\n\n` +
        `🔄 استفاده از Username قبلی:\n` +
        `لینک قبلی حفظ می‌شود و حجم و اعتبار آن با سرویس جدید جایگزین می‌شود.\n\n` +
        `🆕 ساخت Username جدید:\n` +
        `یک سرویس مستقل با لینک جدید ساخته می‌شود.\n\n` +
        `Username موردنظر را انتخاب کن:`,
      Markup.inlineKeyboard(buttons),
    );

    return;
  }

  buttons.push([Markup.button.callback('🎲 ساخت خودکار UUID', 'username_auto')]);

  buttons.push([Markup.button.callback('✏️ انتخاب Username دلخواه', 'username_custom')]);

  buttons.push([Markup.button.callback(' لغو خرید', 'cancel_purchase')]);

  await ctx.reply(
    `👤 برای سرویس جدید Username انتخاب کن.\n\n` + `می‌توانی Username دلخواه وارد کنی یا اجازه بدهی یک UUID به‌صورت خودکار ساخته شود.`,
    Markup.inlineKeyboard(buttons),
  );
}

async function showNewUsernameOptions(ctx) {
  const purchase = ctx.session.purchase;

  if (!purchase) {
    return ctx.reply('فرایند خرید پیدا نشد.');
  }

  purchase.step = 'new_username';

  await ctx.reply(
    'برای سرویس جدید Username انتخاب کن:',
    Markup.inlineKeyboard([
      [Markup.button.callback('🎲 ساخت خودکار UUID', 'username_auto')],
      [Markup.button.callback('✏️ انتخاب Username دلخواه', 'username_custom')],
      [Markup.button.callback('🔙 بازگشت به Usernameهای قبلی', 'username_back')],
      [Markup.button.callback(' لغو خرید', 'cancel_purchase')],
    ]),
  );
}

// --------------------------------------------------
// Invoice
// --------------------------------------------------

async function showInvoice(ctx) {
  const purchase = ctx.session.purchase;

  if (!purchase) {
    return ctx.reply('اطلاعات خرید پیدا نشد. لطفاً دوباره شروع کن.');
  }

  const product = getProduct(purchase.productId);

  if (!product) {
    clearPurchase(ctx);

    return ctx.reply('سرویس انتخاب‌شده دیگر وجود ندارد.');
  }

  const server = getSelectedServerInfo(purchase);

  if (!server) {
    return ctx.reply('اطلاعات سرور پیدا نشد.');
  }

  purchase.step = 'confirm';

  const extraPrice = getPriceExtra(purchase.limitIp);

  const finalPrice = calculateProductPrice(product.price, purchase.limitIp);

  const usernameType = purchase.profileInboundId ? 'استفاده از Username قبلی' : 'ساخت سرویس جدید';

  await ctx.reply(
    `🧾 پیش‌فاکتور خرید VPN\n\n` +
      `🌍 کشور سرویس: ${server.countryName}\n` +
      `📦 حجم: ${product.trafficLabel}\n` +
      `⏳ مدت: ${product.duration}\n` +
      `👥 تعداد کاربران: ${getUserLimitLabel(purchase.limitIp)}\n` +
      `👤 Username: ${purchase.username}\n` +
      `🔧 نوع خرید: ${usernameType}\n\n` +
      `💵 قیمت پایه: ${formatPrice(product.price)}\n` +
      `👥 هزینه تعداد کاربران: ${formatPrice(extraPrice)}\n` +
      `💰 مبلغ قابل پرداخت: ${formatPrice(finalPrice)}\n\n` +
      `توجه: با فعال‌سازی خرید روی Username قبلی، حجم و اعتبار قبلی حذف و سرویس جدید جایگزین می‌شود.\n\n` +
      `اطلاعات را بررسی و سفارش را ثبت کن.`,
    Markup.inlineKeyboard([
      [Markup.button.callback(' تأیید و ثبت سفارش', 'confirm_order')],
      [Markup.button.callback('🔄 تغییر Username', 'change_username')],
      [Markup.button.callback(' لغو خرید', 'cancel_purchase')],
    ]),
  );
}

// --------------------------------------------------
// Payment invoice
// --------------------------------------------------

async function sendPaymentInvoice(ctx, order) {
  const cardNumber = process.env.PAYMENT_CARD_NUMBER;
  const cardOwner = process.env.PAYMENT_CARD_OWNER;

  if (!cardNumber || !cardOwner) {
    throw new Error('PAYMENT_CARD_NUMBER or PAYMENT_CARD_OWNER is missing');
  }

  const product = getProduct(order.product_id);

  if (!product) {
    throw new Error('Product not found');
  }

  await ctx.reply(
    `💳 اطلاعات پرداخت سفارش شما\n\n` +
      `شماره سفارش: ${order.id}\n` +
      `کشور سرویس: ${order.country || product.countryName}\n` +
      `مدت: ${order.duration_months} ماه\n` +
      `حجم: ${order.unlimited ? 'نامحدود' : `${order.traffic_gb} گیگابایت`}\n` +
      `تعداد کاربران: ${getUserLimitLabel(order.limit_ip)}\n` +
      `Username: ${order.xui_email}\n\n` +
      `مبلغ قابل پرداخت: ${formatPrice(order.price)}\n\n` +
      `شماره کارت:\n${cardNumber}\n\n` +
      `به نام:\n${cardOwner}\n\n` +
      `پس از واریز، تصویر رسید را به‌صورت عکس در همین گفتگو ارسال کن.`,
    Markup.inlineKeyboard([[Markup.button.callback(' لغو سفارش', `cancel_order_${order.id}`)]]),
  );
}

// --------------------------------------------------
// Copyable links
// --------------------------------------------------

async function sendCopyableLink(chatId, title, url, buttonText) {
  if (!url || typeof url !== 'string') {
    throw new Error(`${title} is empty or invalid`);
  }

  await bot.telegram.callApi('sendMessage', {
    chat_id: chatId,
    text: `${title}\n${url}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: buttonText,
            copy_text: {
              text: url,
            },
          },
        ],
      ],
    },
  });
}

// --------------------------------------------------
// Provision service
// --------------------------------------------------

async function createAndDeliverService(orderId, adminCtx) {
  let order = getOrder(orderId);

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.payment_status !== 'paid') {
    throw new Error('Payment is not approved');
  }

  if (order.provision_status === 'completed') {
    return adminCtx.reply(`سرویس سفارش ${orderId} قبلاً ساخته شده است.`);
  }

  if (!claimProvision(orderId)) {
    return adminCtx.reply(`سفارش ${orderId} در حال پردازش است یا وضعیت آن اجازه ساخت مجدد نمی‌دهد.`);
  }

  try {
    const product = getProduct(order.product_id);

    if (!product) {
      throw new Error('Product not found');
    }

    const inboundId = Number(order.inbound_id || product.inboundId);

    if (!Number.isInteger(inboundId) || inboundId <= 0) {
      throw new Error('Invalid inboundId');
    }

    // Keep the same subId on retries.
    const subId = order.sub_id || crypto.randomBytes(12).toString('hex');

    updateOrder(orderId, {
      sub_id: subId,
    });

    order = getOrder(orderId);

    const durationDays = Number(order.duration_months) * 30;

    const trafficGb = Number(order.traffic_gb || 0);

    const result = await provisionClient({
      email: order.xui_email,
      subId,
      inboundId,
      telegramId: Number(order.telegram_user_id),
      durationDays,
      trafficGb,
      limitIp: Number(order.limit_ip),
    });

    // Save or update the user's service profile.
    // The selected username becomes the default one.
    saveServiceProfile({
      userId: order.telegram_user_id,
      username: result.email,
      subId: result.subId,
      inboundId: result.inboundId,
    });

    updateOrder(orderId, {
      status: 'active',
      provision_status: 'completed',
      xui_email: result.email,
      sub_id: result.subId,
      inbound_id: result.inboundId,
    });

    const userMessage =
      `پرداخت شما تأیید شد.\n\n` +
      `شماره سفارش: ${order.id}\n` +
      `👤 Username: ${result.email}\n` +
      `📦 حجم جدید: ${order.unlimited ? 'نامحدود' : `${trafficGb} گیگابایت`}\n` +
      `⏳ مدت جدید: ${durationDays} روز\n` +
      `👥 تعداد کاربران: ${getUserLimitLabel(order.limit_ip)}\n\n` +
      `حجم و اعتبار قبلی این Username جایگزین شده‌اند.\n` +
      `UUID و لینک قبلی حفظ شده‌اند.\n\n` +
      `لینک‌ها را با دکمه زیر هر پیام کپی کن.`;

    try {
      await bot.telegram.sendMessage(order.telegram_user_id, userMessage);

      await sendCopyableLink(order.telegram_user_id, '🔗 لینک VLESS:', result.vlessUrl, '📋 کپی لینک VLESS');

      await sendCopyableLink(order.telegram_user_id, '📡 لینک Subscription:', result.subscriptionUrl, '📋 کپی لینک Subscription');
    } catch (deliveryError) {
      console.error('Service created, but Telegram delivery failed:', deliveryError);

      await adminCtx.reply(`سرویس سفارش ${orderId} ساخته شد، اما ارسال پیام به کاربر شکست خورد.\n` + `خطا: ${deliveryError.message}`);
    }

    await adminCtx.reply(
      ` سفارش ${orderId} با موفقیت فعال شد.\n` +
        `Username: ${result.email}\n` +
        `Inbound: ${result.inboundId}\n` +
        `Existing client updated: ${result.updatedExistingClient ? 'Yes' : 'No'}`,
    );

    return result;
  } catch (error) {
    updateOrder(orderId, {
      status: 'failed',
      provision_status: 'failed',
    });

    console.error(`Provisioning failed for order ${orderId}:`, error);

    await adminCtx.reply(
      ` پرداخت سفارش ${orderId} تأیید شده، اما ساخت یا به‌روزرسانی سرویس شکست خورد.\n\n` +
        `خطا: ${error.message}\n\n` +
        `قبل از تلاش مجدد، وضعیت کلاینت را در 3x-ui بررسی کن.\n` +
        `سپس دستور زیر را اجرا کن:\n` +
        `/retry_${orderId}`,
    );
  }
}
// --------------------------------------------------
// Start
// --------------------------------------------------

bot.start(async (ctx) => {
  clearPurchase(ctx);

  await ctx.reply(`سلام 👋\n\nبه ${process.env.STORE_NAME} خوش آمدید.`, mainMenu());
});

bot.command('myid', async (ctx) => {
  await ctx.reply(`Telegram ID: ${ctx.from.id}`);
});

// --------------------------------------------------
// Purchase: country
// --------------------------------------------------

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery();

  clearPurchase(ctx);

  const countries = [
    ...new Map(
      products.map((product) => [
        product.country,
        {
          code: product.country,
          name: product.countryName,
          flag: product.name.split(' ')[0],
        },
      ]),
    ).values(),
  ];

  const buttons = countries.map((country) => [Markup.button.callback(`${country.flag} ${country.name}`, `country_${country.code}`)]);

  buttons.push([Markup.button.callback('🔙 منوی اصلی', 'main_menu')]);

  await ctx.reply('🌍 لوکیش  موردنظرت رو انتخاب کن:', Markup.inlineKeyboard(buttons));
});

bot.action(/^country_(DE|NL)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const country = ctx.match[1];

  ctx.session.purchase = {
    country,
    step: 'duration',
  };

  const countryName = products.find((product) => product.country === country)?.countryName;

  await ctx.reply(
    `🌍 کشور انتخاب‌شده: ${countryName}\n\n` + `⏳ مدت اشتراک را انتخاب کن:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('۱ ماهه', `duration_${country}_1`)],
      [Markup.button.callback('۲ ماهه', `duration_${country}_2`)],
      [Markup.button.callback('۳ ماهه', `duration_${country}_3`)],
      [Markup.button.callback('🔙 بازگشت', 'show_products')],
    ]),
  );
});

// --------------------------------------------------
// Purchase: duration
// --------------------------------------------------

bot.action(/^duration_(DE|NL)_(1|2|3)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const country = ctx.match[1];
  const months = Number(ctx.match[2]);

  const purchase = ctx.session.purchase;

  if (!purchase || purchase.country !== country) {
    return ctx.reply('مرحله خرید معتبر نیست. دوباره شروع کن.');
  }

  purchase.months = months;
  purchase.step = 'traffic';

  const countryName = products.find((product) => product.country === country)?.countryName;

  const availableProducts = products.filter((product) => product.country === country && Number(product.months) === months);

  const buttons = availableProducts.map((product) => [Markup.button.callback(`${product.trafficLabel} | ${formatPrice(product.price)}`, `select_plan_${product.id}`)]);

  buttons.push([Markup.button.callback('🔙 بازگشت به لوکیشن', 'show_products')]);

  await ctx.reply(`🌍 کشور: ${countryName}\n` + `⏳ مدت: ${months} ماه\n\n` + `📦 حجم موردنظرت رو انتخاب کن:`, Markup.inlineKeyboard(buttons));
});

// --------------------------------------------------
// Purchase: plan
// --------------------------------------------------

bot.action(/^select_plan_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const product = getProduct(ctx.match[1]);
  const purchase = ctx.session.purchase;

  if (!product || !purchase || purchase.country !== product.country || Number(purchase.months) !== Number(product.months) || purchase.step !== 'traffic') {
    return ctx.reply('سرویسی که انتخاب کردی در حال حاضر در دسترس نیست 😔 , در حال بررسی موضـوع هستیـم.');
  }

  purchase.productId = product.id;
  purchase.step = 'limit';

  await ctx.reply(
    ` سرویس انتخاب شد:\n\n` +
      `🌍 کشور: ${product.countryName}\n` +
      `⏳ مدت: ${product.duration}\n` +
      `📦 حجم: ${product.trafficLabel}\n` +
      `💰 قیمت پایه (۱ کاربره): ${formatPrice(product.price)}\n\n` +
      `👥 تعداد کاربران مجاز هم‌زمان را انتخاب کن:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('۱ کاربره', 'limit_1'), Markup.button.callback('۲ کاربره', 'limit_2')],
      [Markup.button.callback('۳ کاربره', 'limit_3'), Markup.button.callback('بدون محدودیت', 'limit_0')],
      [Markup.button.callback('🔙 بازگشت به انتخاب حجم', `duration_${product.country}_${product.months}`)],
      [Markup.button.callback(' لغو خرید', 'cancel_purchase')],
    ]),
  );
});

// --------------------------------------------------
// Purchase: limit
// --------------------------------------------------

bot.action(/^limit_(0|1|2|3)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session.purchase;

  if (!purchase || purchase.step !== 'limit') {
    return ctx.reply('مرحله خرید منقضی شده, دوباره شروع کن.');
  }

  purchase.limitIp = Number(ctx.match[1]);

  await showUsernameOptions(ctx);
});

// --------------------------------------------------
// Purchase: use old profile
// --------------------------------------------------

bot.action(/^profile_use_([a-zA-Z0-9_-]{3,64})$/, async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session.purchase;

  if (!purchase || purchase.step !== 'choose_username') {
    return ctx.reply('مرحله انتخاب Username معتبر نیست.');
  }

  const username = ctx.match[1];

  const profile = getUserProfile(ctx.from.id, username);

  if (!profile) {
    return ctx.reply('این Username در حساب شما پیدا نشد. دوباره انتخاب کن.');
  }

  purchase.username = profile.xui_email;
  purchase.profileInboundId = Number(profile.inbound_id) || null;
  purchase.profileSubId = profile.sub_id || null;

  await showInvoice(ctx);
});

bot.action('username_new', async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session.purchase;

  if (!purchase) {
    return ctx.reply('فرایند خرید پیدا نشد.');
  }

  await showNewUsernameOptions(ctx);
});

bot.action('username_back', async (ctx) => {
  await ctx.answerCbQuery();

  await showUsernameOptions(ctx);
});

// --------------------------------------------------
// Purchase: new username
// --------------------------------------------------

bot.action('username_auto', async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session.purchase;

  if (!purchase || !['choose_username', 'new_username', 'username'].includes(purchase.step)) {
    return ctx.reply('مرحله انتخاب Username معتبر نیست.');
  }

  let username;

  // Generate a unique username.
  do {
    username = createUsername();
  } while (isUsernameTaken(username));

  purchase.username = username;
  purchase.profileInboundId = null;
  purchase.profileSubId = null;

  await showInvoice(ctx);
});

bot.action('username_custom', async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session.purchase;

  if (!purchase || !['new_username', 'username'].includes(purchase.step)) {
    return ctx.reply('مرحله انتخاب Username معتبر نیست.');
  }

  purchase.step = 'awaiting_username';

  await ctx.reply('✏️ Username دلخواه را ارسال کن.\n\n' + 'فقط حروف انگلیسی، عدد، _ و - مجاز هستند.\n' + 'حداقل ۳ و حداکثر ۳۲ کاراکتر.');
});

bot.on('text', async (ctx, next) => {
  const purchase = ctx.session?.purchase;

  if (!purchase || purchase.step !== 'awaiting_username') {
    return next();
  }

  const username = ctx.message.text.trim();

  if (username.startsWith('/')) {
    return next();
  }

  if (!isValidUsername(username)) {
    return ctx.reply(' فرمت Username معتبر نیست. باید ۳ تا ۳۲ کاراکتر و فقط شامل حروف انگلیسی، عدد، _ یا - باشد.');
  }

  if (isUsernameTaken(username)) {
    return ctx.reply(' این Username قبلاً استفاده شده است. برای استفاده از آن، از فهرست Usernameهای قبلی انتخابش کن.');
  }

  purchase.username = username;
  purchase.profileInboundId = null;
  purchase.profileSubId = null;
  purchase.step = 'confirm';

  await showInvoice(ctx);
});

bot.action('change_username', async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session.purchase;

  if (!purchase) {
    return ctx.reply('فرایند خرید پیدا نشد.');
  }

  delete purchase.username;
  delete purchase.profileInboundId;
  delete purchase.profileSubId;

  await showUsernameOptions(ctx);
});

// --------------------------------------------------
// Purchase: confirm order
// --------------------------------------------------

bot.action('confirm_order', async (ctx) => {
  const purchase = ctx.session?.purchase;

  if (!purchase || purchase.step !== 'confirm' || !purchase.productId || !purchase.username || !Number.isInteger(purchase.limitIp)) {
    return ctx.answerCbQuery('اطلاعات سفارش ناقص است.', { show_alert: true });
  }

  const product = getProduct(purchase.productId);

  if (!product) {
    return ctx.answerCbQuery('محصول پیدا نشد.', { show_alert: true });
  }

  const existingOpenOrder = getUserOrders(ctx.from.id).find((order) => ['awaiting_payment', 'payment_review'].includes(order.status));

  if (existingOpenOrder) {
    return ctx.answerCbQuery(`ابتدا وضعیت سفارش ${existingOpenOrder.id} را مشخص کن.`, { show_alert: true });
  }

  let profile = null;

  if (purchase.profileInboundId) {
    profile = getUserProfile(ctx.from.id, purchase.username);

    if (!profile) {
      return ctx.answerCbQuery('Username انتخاب‌شده معتبر نیست.', { show_alert: true });
    }
  } else if (isUsernameTaken(purchase.username)) {
    return ctx.answerCbQuery('این Username قبلاً استفاده شده است. آن را از فهرست Usernameهای قبلی انتخاب کن.', { show_alert: true });
  }

  const selectedInboundId = profile?.inbound_id ? Number(profile.inbound_id) : Number(product.inboundId);

  const serverProduct = profile?.inbound_id ? getProductByInbound(profile.inbound_id) : null;

  const extraPrice = getPriceExtra(purchase.limitIp);

  const finalPrice = calculateProductPrice(product.price, purchase.limitIp);

  const orderProduct = {
    ...product,
    price: finalPrice,
    basePrice: Number(product.price),
    extraPrice,
    inboundId: selectedInboundId,
    country: serverProduct?.country || product.country,
  };

  let order;

  try {
    order = createOrder({
      userId: ctx.from.id,
      telegramUsername: ctx.from.username,
      product: orderProduct,
      xuiEmail: purchase.username,
      limitIp: purchase.limitIp,
      inboundId: selectedInboundId,
    });
  } catch (error) {
    console.error('Create order failed:', error);

    return ctx.answerCbQuery('ثبت سفارش انجام نشد. اطلاعات سفارش را بررسی کن.', { show_alert: true });
  }

  clearPurchase(ctx);

  await ctx.answerCbQuery('سفارش ثبت شد.');

  try {
    await sendPaymentInvoice(ctx, order);
  } catch (error) {
    console.error('Payment invoice error:', error);

    await ctx.reply(`سفارش ${order.id} ثبت شد، اما اطلاعات پرداخت ارسال نشد. با پشتیبانی تماس بگیر.`);
  }
});

// --------------------------------------------------
// Cancel order / purchase
// --------------------------------------------------

bot.action(/^cancel_order_(\d+)$/, async (ctx) => {
  const orderId = Number(ctx.match[1]);

  const cancelled = cancelUnpaidOrder(orderId, ctx.from.id);

  if (!cancelled) {
    return ctx.answerCbQuery('این سفارش پیدا نشد یا دیگر قابل لغو نیست.', { show_alert: true });
  }

  await ctx.answerCbQuery('سفارش لغو شد.');

  await ctx.reply(`سفارش ${orderId} لغو شد.`, mainMenu());
});

bot.action('cancel_purchase', async (ctx) => {
  await ctx.answerCbQuery();

  clearPurchase(ctx);

  await ctx.reply('خرید لغو شد.', mainMenu());
});

bot.command('cancel', async (ctx) => {
  clearPurchase(ctx);

  await ctx.reply('فرایند خرید لغو شد.', mainMenu());
});

// --------------------------------------------------
// Payment receipt
// --------------------------------------------------

bot.on('photo', async (ctx) => {
  try {
    const payableOrder = getUserOrders(ctx.from.id).find((order) => ['awaiting_payment', 'rejected'].includes(order.status));

    if (!payableOrder) {
      return ctx.reply('سفارش آماده دریافت رسید پیدا نشد.');
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];

    const saved = submitPaymentReceipt(payableOrder.id, ctx.from.id, photo.file_id);

    if (!saved) {
      return ctx.reply('وضعیت سفارش تغییر کرده است و این رسید ثبت نشد.');
    }

    const order = getOrder(payableOrder.id);
    const product = getProduct(order.product_id);

    await ctx.reply(` رسید سفارش ${order.id} دریافت شد.\n\n` + `وضعیت: در انتظار بررسی ادمین\n` + `پس از تأیید پرداخت، سرویس برایت فعال می‌شود.`);

    const caption =
      `🧾 رسید پرداخت جدید\n\n` +
      `شماره سفارش: ${order.id}\n` +
      `شناسه تلگرام: ${order.telegram_user_id}\n` +
      `Username تلگرام: ${order.telegram_username || 'ندارد'}\n\n` +
      `کشور: ${order.country || product?.countryName}\n` +
      `مدت: ${order.duration_months} ماه\n` +
      `حجم: ${order.unlimited ? 'نامحدود' : `${order.traffic_gb} گیگابایت`}\n` +
      `تعداد کاربران: ${getUserLimitLabel(order.limit_ip)}\n` +
      `Username سرویس: ${order.xui_email}\n` +
      `مبلغ: ${formatPrice(order.price)}\n\n` +
      `وضعیت: در انتظار بررسی`;

    await ctx.telegram.sendPhoto(ADMIN_ID, photo.file_id, {
      caption,
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback(' تأیید پرداخت', `payment_approve_${order.id}`)],
        [Markup.button.callback(' رد پرداخت', `payment_reject_${order.id}`)],
      ]).reply_markup,
    });
  } catch (error) {
    console.error('Payment receipt error:', error);

    await ctx.reply('در دریافت یا ارسال رسید خطایی رخ داد. وضعیت سفارش را بررسی کن.');
  }
});

// --------------------------------------------------
// Admin: approve payment
// --------------------------------------------------

bot.action(/^payment_approve_(\d+)$/, async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) {
    return ctx.answerCbQuery('اجازه تأیید پرداخت را نداری.', { show_alert: true });
  }

  const orderId = Number(ctx.match[1]);
  const approved = approvePayment(orderId);

  if (!approved) {
    return ctx.answerCbQuery('این سفارش در انتظار بررسی نیست یا قبلاً بررسی شده است.', { show_alert: true });
  }

  await ctx.answerCbQuery('پرداخت تأیید شد.');

  try {
    await ctx.editMessageCaption(` پرداخت سفارش ${orderId} تأیید شد.\nدر حال ساخت یا به‌روزرسانی سرویس...`);
  } catch (error) {
    console.error('Could not update receipt caption:', error);
  }

  await createAndDeliverService(orderId, ctx);
});

// --------------------------------------------------
// Admin: reject payment
// --------------------------------------------------

bot.action(/^payment_reject_(\d+)$/, async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) {
    return ctx.answerCbQuery('اجازه رد پرداخت را نداری.', { show_alert: true });
  }

  const orderId = Number(ctx.match[1]);
  const order = getOrder(orderId);

  if (!order) {
    return ctx.answerCbQuery('سفارش پیدا نشد.', { show_alert: true });
  }

  const rejected = rejectPayment(orderId, 'رسید پرداخت توسط ادمین تأیید نشد.');

  if (!rejected) {
    return ctx.answerCbQuery('این سفارش در انتظار بررسی نیست یا قبلاً بررسی شده است.', { show_alert: true });
  }

  await ctx.answerCbQuery('رسید رد شد.');

  try {
    await ctx.telegram.sendMessage(order.telegram_user_id, ` رسید پرداخت سفارش ${orderId} تأیید نشد.\n\n` + `می‌توانی تصویر رسید صحیح را دوباره ارسال کنی.`);
  } catch (error) {
    console.error('Could not notify user:', error);
  }

  try {
    await ctx.editMessageCaption(` رسید پرداخت سفارش ${orderId} توسط ادمین رد شد.`);
  } catch (error) {
    console.error('Could not update rejected caption:', error);
  }
});

// --------------------------------------------------
// Admin: retry provisioning
// --------------------------------------------------

bot.hears(/^\/retry_(\d+)(?:@\w+)?$/, async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) {
    return ctx.reply('⛔ دسترسی غیرمجاز.');
  }

  const orderId = Number(ctx.match[1]);
  const order = getOrder(orderId);

  if (!order) {
    return ctx.reply('سفارش پیدا نشد.');
  }

  if (order.payment_status !== 'paid') {
    return ctx.reply('این سفارش هنوز پرداخت تأییدشده ندارد.');
  }

  if (order.provision_status === 'completed') {
    return ctx.reply('سرویس این سفارش قبلاً ساخته شده است.');
  }

  await createAndDeliverService(orderId, ctx);
});

// --------------------------------------------------
// User: orders
// --------------------------------------------------

bot.action('my_orders', async (ctx) => {
  await ctx.answerCbQuery();

  const orders = getUserOrders(ctx.from.id);

  if (!orders.length) {
    return ctx.reply('هنوز سفارشی ثبت نکرده‌ای.');
  }

  const message = orders
    .slice(0, 10)
    .map((order) => {
      const product = getProduct(order.product_id);

      return (
        `🧾 سفارش #${order.id}\n` +
        `سرویس: ${product?.name || 'نامشخص'}\n` +
        `Username: ${order.xui_email || 'نامشخص'}\n` +
        `مبلغ: ${order.price ? formatPrice(order.price) : 'نامشخص'}\n` +
        `وضعیت: ${getStatusLabel(order.status)}`
      );
    })
    .join('\n\n');

  await ctx.reply(message);
});

// --------------------------------------------------
// Admin: orders
// --------------------------------------------------

bot.command('orders', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) {
    return ctx.reply('⛔ دسترسی غیرمجاز.');
  }

  const orders = getPendingOrders();

  if (!orders.length) {
    return ctx.reply('سفارش در انتظار یا نیازمند پیگیری وجود ندارد.');
  }

  const message = orders
    .slice(0, 30)
    .map(
      (order) =>
        `#${order.id}\n` +
        `User: ${order.telegram_user_id}\n` +
        `Username: ${order.xui_email || 'ندارد'}\n` +
        `Price: ${formatPrice(order.price || 0)}\n` +
        `Status: ${getStatusLabel(order.status)}\n` +
        `Payment: ${order.payment_status}\n` +
        `Provision: ${order.provision_status}` +
        (order.provision_status === 'failed' ? `\n/retry_${order.id}` : ''),
    )
    .join('\n\n');

  await ctx.reply(message);
});

bot.command('receipt', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) {
    return ctx.reply('⛔ دسترسی غیرمجاز.');
  }

  const match = ctx.message.text.match(/^\/receipt(?:@\w+)?\s+(\d+)$/);

  if (!match) {
    return ctx.reply('فرمت صحیح: /receipt 15');
  }

  const order = getOrder(Number(match[1]));

  if (!order || !order.payment_photo_file_id) {
    return ctx.reply('رسید ذخیره‌شده‌ای برای این سفارش پیدا نشد.');
  }

  await ctx.replyWithPhoto(order.payment_photo_file_id, {
    caption: `رسید ذخیره‌شده سفارش ${order.id}\n` + `وضعیت: ${getStatusLabel(order.status)}`,
  });
});

// --------------------------------------------------
// Navigation / support
// --------------------------------------------------

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();

  clearPurchase(ctx);

  await ctx.reply('منوی اصلی:', mainMenu());
});

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();

  const username = (process.env.SUPPORT_USERNAME || '').replace(/^@/, '');

  if (!username) {
    return ctx.reply('اطلاعات پشتیبانی تنظیم نشده است.');
  }

  await ctx.reply(`📞 پشتیبانی: @${username}`, Markup.inlineKeyboard([[Markup.button.url('ارتباط با پشتیبانی', `https://t.me/${username}`)]]));
});

// --------------------------------------------------
// Error handling / startup
// --------------------------------------------------

bot.catch((error, ctx) => {
  console.error(`Telegram error on ${ctx.updateType}:`, error);
});

async function startBot() {
  try {
    console.log('Starting Telegram bot...');

    const me = await bot.telegram.getMe();

    console.log(`Authenticated as @${me.username}`);

    await bot.launch();

    console.log('Telegram bot started successfully!');
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

startBot();
