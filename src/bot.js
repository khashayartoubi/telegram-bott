require('dotenv').config();

const crypto = require('crypto');
const QRCode = require('qrcode');
const { Telegraf, Markup, session } = require('telegraf');

const products = require('./config/catalog');
const { USER_LIMIT_OPTIONS, COUNTRIES, isCountryEnabled } = require('./config/catalog');
const texts = require('./config/texts');
const { createUsername, isValidUsername } = require('./utils/usernames');
const { START_MENU, TRIAL_ACCOUNT, DISCOUNT_CODES, CONNECTION_TUTORIALS, REQUIRED_CHANNEL, SUPPORT, MAX_SERVICE_PROFILES } = require('./config/features');

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
  getTrialAccount,
  saveTrialAccount,
} = require('./database/db');

const { provisionClient, findClientByIdentifier } = require('./services/xui.service');

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

function callbackButton(text, action, tone) {
  // Telegram does not allow custom inline-button background colours. The
  // leading colour marker keeps the role clear in every Telegram client.
  const icons = { danger: '🔴', neutral: '⚪', success: '🟢' };
  const icon = icons[tone] || '';
  const label = icon && !text.startsWith(icon) ? `${icon} ${text}` : text;

  return { text: label, callback_data: action };
}

function backButton(text = '🔙 بازگشت', action = 'main_menu') {
  return callbackButton(text, action, /لغو|انصراف/.test(text) ? 'danger' : 'neutral');
}

function successButton(text, action) {
  return callbackButton(text, action, 'success');
}

function dangerButton(text, action) {
  return callbackButton(text, action, 'danger');
}

function mainMenu() {
  const items = START_MENU.filter((item) => item.enabled);
  const toButton = (item) => ({ text: item.label, ...(item.style ? { style: item.style } : {}) });

  if (items.length <= 2) return Markup.keyboard(items.map((item) => [toButton(item)])).resize();

  const first = items[0];
  const last = items.at(-1);
  const middleRows = [];

  for (let index = 1; index < items.length - 1; index += 2) {
    middleRows.push(items.slice(index, index + 2).map(toButton));
  }

  return Markup.keyboard([[toButton(first)], ...middleRows, [toButton(last)]]).resize();
}

function fullWidthKeyboard(labels) {
  return Markup.keyboard(labels.map((label) => [label])).resize();
}

function getProduct(productId) {
  return products.find((product) => String(product.id) === String(productId));
}

function getProductByInbound(inboundId) {
  return products.find((product) => Number(product.inboundId) === Number(inboundId));
}

function getCountryName(countryCode) {
  return COUNTRIES.find((country) => country.code === countryCode)?.name || countryCode || 'نامشخص';
}

function getPurchasableProducts() {
  return products.filter((product) => isCountryEnabled(product.country));
}

function getUserLimitLabel(limitIp) {
  return USER_LIMIT_OPTIONS.find((option) => option.value === Number(limitIp))?.label || 'نامشخص';
}

// قیمت اضافه بر اساس تعداد کاربران
function getPriceExtra(limitIp) {
  const extra = USER_LIMIT_OPTIONS.find((option) => option.value === Number(limitIp))?.extraPrice;

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

function getDiscount({ code, productId, price }) {
  const discount = DISCOUNT_CODES.find((item) => String(item.code).toUpperCase() === String(code).toUpperCase() && item.enabled !== false);

  if (!discount) return null;

  const productIds = discount.productIds || [];
  if (productIds.length && !productIds.map(Number).includes(Number(productId))) return null;

  const value = Number(discount.value);
  const basePrice = Number(price);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(basePrice) || basePrice < 0) return null;

  const amount = discount.type === 'percent' ? Math.floor((basePrice * value) / 100) : Math.floor(value);

  return {
    code: String(discount.code).toUpperCase(),
    amount: Math.min(basePrice, amount),
  };
}

function getPurchasePricing(purchase, product) {
  const beforeDiscount = calculateProductPrice(product.price, purchase.limitIp);
  const discount = purchase.discountCode ? getDiscount({ code: purchase.discountCode, productId: product.id, price: beforeDiscount }) : null;

  return {
    beforeDiscount,
    discount,
    finalPrice: beforeDiscount - (discount?.amount || 0),
  };
}

function canCreateNewUsername(userId) {
  return getUserProfiles(userId).length < MAX_SERVICE_PROFILES;
}

async function ensureRequiredChannelMembership(ctx) {
  if (!REQUIRED_CHANNEL.enabled) return true;

  const chatId = String(REQUIRED_CHANNEL.chatId || '').trim();
  if (!chatId || !REQUIRED_CHANNEL.joinUrl) {
    await ctx.reply('تنظیمات عضویت کانال کامل نیست. لطفاً بعداً دوباره تلاش کن.');
    return false;
  }

  try {
    const member = await bot.telegram.getChatMember(chatId, ctx.from.id);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status) || (member.status === 'restricted' && member.is_member);

    if (isMember) return true;
  } catch (error) {
    console.error('Required channel membership check failed:', error);
  }

  await ctx.reply(
    'برای خرید کانفیگ ابتدا عضو کانال زیر شو، سپس دوباره گزینهٔ خرید را انتخاب کن.',
    Markup.inlineKeyboard([[Markup.button.url('📢 عضویت در کانال', REQUIRED_CHANNEL.joinUrl)]]),
  );
  return false;
}

function clearPurchase(ctx) {
  if (ctx.session) {
    delete ctx.session.purchase;
  }
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);

  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(0)} مگابایت`;
  }

  return `${(value / 1024 / 1024 / 1024).toFixed(2)} گیگابایت`;
}

function getLinkIdentifier(link) {
  try {
    const url = new URL(link.trim());
    if (url.protocol === 'vless:') return decodeURIComponent(url.username);

    // Support both the default `/subscription/<subId>` form and custom
    // subscription gateways that put the identifier in a query parameter.
    const queryIdentifier = ['subId', 'subid', 'token', 'id'].map((key) => url.searchParams.get(key)).find(Boolean);
    if (queryIdentifier) return queryIdentifier;

    return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '');
  } catch {
    return null;
  }
}

function getRemainingDays(expiryTime) {
  let expiry = Number(expiryTime);
  if (!Number.isFinite(expiry) || expiry <= 0) return 0;

  // برخی نسخه‌های پنل timestamp را بر حسب ثانیه برمی‌گردانند، نه میلی‌ثانیه.
  if (expiry < 100_000_000_000) expiry *= 1000;

  const remaining = expiry - Date.now();
  return Math.max(0, Math.ceil(remaining / 86_400_000));
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

async function showMyOrders(ctx, keyboard = mainMenu()) {
  const orders = getUserOrders(ctx.from.id);

  if (!orders.length) {
    return ctx.reply('هنوز سفارشی ثبت نکرده‌ای.', keyboard);
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

  // فقط سفارش‌هایی که هنوز پرداخت آن‌ها تأیید نشده قابل لغو/ویرایش‌اند.
  const buttons = orders
    .filter((order) => ['awaiting_payment', 'rejected'].includes(order.status))
    .slice(0, 10)
    .flatMap((order) => [
      [Markup.button.callback(`✏️ ویرایش سفارش #${order.id}`, `edit_order_${order.id}`)],
      [dangerButton(`لغو سفارش #${order.id}`, `cancel_order_${order.id}`)],
    ]);

  if (buttons.length) {
    buttons.push([backButton()]);
    return ctx.reply(message, Markup.inlineKeyboard(buttons));
  }

  return ctx.reply(message, keyboard);
}

function getSelectedServerInfo(purchase) {
  const product = getProduct(purchase.productId);

  if (!product) return null;

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

  // همهٔ Usernameهای کاربر باید قابل انتخاب باشند؛ هنگام استفاده از مورد
  // قبلی، همان inbound قبلی حفظ می‌شود و به کشور انتخاب‌شده محدود نیست.
  const profiles = getUserProfiles(ctx.from.id);

  purchase.step = 'choose_username';

  const buttons = [];

  if (profiles.length) {
    for (const profile of profiles) {
      const defaultLabel = profile.is_default ? ' ⭐ پیش‌فرض' : '';

      buttons.push([Markup.button.callback(`🔄 ${profile.xui_email}${defaultLabel}`, `profile_use_${profile.xui_email}`)]);
    }

    if (canCreateNewUsername(ctx.from.id)) {
      buttons.push([Markup.button.callback('➕ ساخت Username جدید', 'username_new')]);
    }

    await ctx.reply(
      `👤 انتخاب Username سرویس\n\n` +
        `می‌توانی از یکی از Usernameهای قبلی استفاده کنی یا یک Username جدید بسازی.\n\n` +
        `🔄 استفاده از Username قبلی:\n` +
        `لینک قبلی حفظ می‌شود و حجم و اعتبار آن با سرویس جدید جایگزین می‌شود.\n\n` +
        (canCreateNewUsername(ctx.from.id)
          ? `🆕 ساخت Username جدید:\nیک سرویس مستقل با لینک جدید ساخته می‌شود.\n\n`
          : `به سقف ${MAX_SERVICE_PROFILES} Username رسیده‌ای و باید یکی از موارد بالا را انتخاب کنی.\n\n`) +
        `Username موردنظر را انتخاب کن:`,
      Markup.inlineKeyboard(buttons),
    );

    return;
  }

  buttons.push([Markup.button.callback(texts.username.autoButton, 'username_auto')]);

  buttons.push([Markup.button.callback(texts.username.customButton, 'username_custom')]);

  buttons.push([backButton('لغو خرید', 'cancel_purchase')]);

  await ctx.reply(
    `👤 برای سرویس جدید نام کاربری انتخاب کن.\n\n` + `می‌توانی نام کاربری دلخواه وارد کنی یا اجازه بدهی یک نام کاربری کوتاه به‌صورت خودکار ساخته شود.`,
    Markup.inlineKeyboard(buttons),
  );
}

async function showNewUsernameOptions(ctx) {
  const purchase = ctx.session.purchase;

  if (!purchase) {
    return ctx.reply('فرایند خرید پیدا نشد.');
  }

  if (!canCreateNewUsername(ctx.from.id)) {
    return ctx.reply(`حداکثر ${MAX_SERVICE_PROFILES} Username یکتا می‌توانی داشته باشی. یکی از Usernameهای قبلی را انتخاب کن.`);
  }

  purchase.step = 'new_username';

  await ctx.reply(
    'برای سرویس جدید Username انتخاب کن:',
    Markup.inlineKeyboard([
      [Markup.button.callback(texts.username.autoButton, 'username_auto')],
      [Markup.button.callback(texts.username.customButton, 'username_custom')],
      [backButton('🔙 بازگشت به نام‌های قبلی', 'username_back')],
      [backButton('لغو خرید', 'cancel_purchase')],
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
  const pricing = getPurchasePricing(purchase, product);

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
      (pricing.discount
        ? `🎟 کد تخفیف: ${pricing.discount.code}\n💸 تخفیف: ${formatPrice(pricing.discount.amount)}\n💰 مبلغ قابل پرداخت: ${formatPrice(pricing.finalPrice)}\n\n`
        : `💰 مبلغ قابل پرداخت: ${formatPrice(pricing.finalPrice)}\n\n`) +
      `توجه: با فعال‌سازی خرید روی Username قبلی، حجم و اعتبار قبلی حذف و سرویس جدید جایگزین می‌شود.\n\n` +
      `اطلاعات را بررسی و سفارش را ثبت کن.`,
    Markup.inlineKeyboard([
      [successButton('تأیید و ثبت سفارش', 'confirm_order')],
      [Markup.button.callback('🔄 تغییر نام کاربـری ', 'change_username')],
      [
        pricing.discount
          ? dangerButton('حذف کد تخفیف', 'remove_discount')
          : Markup.button.callback('🎟 وارد کردن کد تخفیف', 'enter_discount'),
      ],
      [backButton('لغو خرید', 'cancel_purchase')],
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
      `کشور سرویس: ${getCountryName(order.country || product.country)}\n` +
      `مدت: ${order.duration_months} ماه\n` +
      `حجم: ${order.unlimited ? 'نامحدود' : `${order.traffic_gb} گیگابایت`}\n` +
      `تعداد کاربران: ${getUserLimitLabel(order.limit_ip)}\n` +
      `Username: ${order.xui_email}\n\n` +
      `مبلغ قابل پرداخت: ${formatPrice(order.price)}\n\n` +
      `شماره کارت:\n${cardNumber}\n\n` +
      `به نام:\n${cardOwner}\n\n` +
      `پس از واریز، تصویر رسید را به‌صورت عکس در همین گفتگو ارسال کن.`,
    Markup.inlineKeyboard([[backButton('لغو سفارش', `cancel_order_${order.id}`)]]),
  );
}

// --------------------------------------------------
// Service delivery
// --------------------------------------------------

async function sendLink(chatId, title, url, copyButtonText) {
  if (!url || typeof url !== 'string') {
    throw new Error(`${title} is empty or invalid`);
  }

  // The text remains selectable. The Telegram `copy_text` button additionally
  // copies with one tap, without the user needing to long-press the link.
  await bot.telegram.sendMessage(chatId, `${title}\n${url}`, {
    reply_markup: Markup.inlineKeyboard([[{ text: copyButtonText, copy_text: { text: url } }]]).reply_markup,
  });
}

async function sendSubscriptionAddLink(chatId, subscriptionUrl) {
  if (!subscriptionUrl || typeof subscriptionUrl !== 'string') {
    throw new Error('Subscription URL is empty or invalid');
  }

  await bot.telegram.sendMessage(
    chatId,
    `🔗 لینک Subscription info\n` + `این همان لینک SUB پنل است؛ آن را در V2Box اضافه کن تا حجم و مدت باقی‌مانده نمایش داده شود.\n\n` + `${subscriptionUrl}`,
    {
      reply_markup: Markup.inlineKeyboard([[{ text: '📋 کپی لینک Subscription info', copy_text: { text: subscriptionUrl } }]]).reply_markup,
    },
  );

  const qrCode = await QRCode.toBuffer(subscriptionUrl, {
    type: 'png',
    width: 768,
    margin: 2,
    errorCorrectionLevel: 'M',
  });

  await bot.telegram.sendPhoto(
    chatId,
    { source: qrCode, filename: 'subscription-qr.png' },
    {
      caption: '📷 QR لینک Subscription\nآن را در V2Box اسکن کن تا حجم و زمان باقی‌مانده نمایش داده شود.',
    },
  );
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
      countryCode: order.country || product.country,
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
      `شناسه اتصال و لینک قبلی حفظ شده‌اند.\n\n` +
      `برای نمایش حجم در V2Box، لینک اشتراک را اضافه یا QR آن را اسکن کن.`;

    try {
      await bot.telegram.sendMessage(order.telegram_user_id, userMessage);

      await sendLink(order.telegram_user_id, texts.delivery.vlessTitle, result.vlessUrl, '📋 کپی خودکار لینک VLESS');
      await sendSubscriptionAddLink(order.telegram_user_id, result.subscriptionUrl);
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

  await ctx.reply(texts.start.welcome, mainMenu());
});

bot.command('myid', async (ctx) => {
  await ctx.reply(`Telegram ID: ${ctx.from.id}`);
});

const menuLabel = (id) => START_MENU.find((item) => item.id === id)?.label;
function registerMenuHandler(id, handler) {
  const label = menuLabel(id);
  if (label) bot.hears(label, handler);
}

registerMenuHandler('buy', async (ctx) => {
  if (await ensureRequiredChannelMembership(ctx)) await showProductSelector(ctx);
});
registerMenuHandler('inquiry', async (ctx) => {
  ctx.session.inquiry = true;
  await ctx.reply(texts.start.inquiry, mainMenu());
});
registerMenuHandler('wallet', async (ctx) => ctx.reply(texts.start.wallet, mainMenu()));
registerMenuHandler('services', async (ctx) => {
  // Keep the same output as the inline action, without faking a callback query.
  const orders = getUserOrders(ctx.from.id).filter((order) => order.status === 'active');
  const trial = getTrialAccount(ctx.from.id);
  if (!orders.length && !trial) return ctx.reply('🖥 هنوز سرویس فعالی نداری.', mainMenu());
  const list = orders.map((order) => `🖥 سرویس #${order.id}\n👤 ${order.xui_email}\n📦 ${order.unlimited ? 'نامحدود' : `${order.traffic_gb} گیگابایت`}`);
  if (trial) list.push(`🎁 اکانت تست\n👤 ${trial.xui_email}\n📦 ${TRIAL_ACCOUNT.trafficLabel}`);
  await ctx.reply(list.join('\n\n'), mainMenu());
});
registerMenuHandler('orders', async (ctx) => showMyOrders(ctx));
registerMenuHandler('tutorials', async (ctx) => {
  const tutorials = CONNECTION_TUTORIALS.filter((item) => item.enabled !== false && item.url);

  if (!tutorials.length) return ctx.reply('آموزش اتصال به‌زودی اضافه می‌شود.', mainMenu());

  await ctx.reply('🎬 آموزش اتصال\n\nویدیوی موردنظرت را انتخاب کن:', Markup.inlineKeyboard(tutorials.map((item) => [Markup.button.url(item.title, item.url)])));
});
registerMenuHandler('support', async (ctx) => startSupport(ctx));
registerMenuHandler('trial', async (ctx) => claimTrial(ctx));

bot.action('inquiry', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.inquiry = true;
  await ctx.reply(texts.start.inquiry, Markup.inlineKeyboard([[backButton()]]));
});

bot.action('wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(texts.start.wallet, Markup.inlineKeyboard([[backButton()]]));
});

async function claimTrial(ctx) {
  if (!TRIAL_ACCOUNT.enabled) return ctx.reply('اکانت تست فعلاً غیرفعال است.', mainMenu());

  const existing = getTrialAccount(ctx.from.id, TRIAL_ACCOUNT.campaignId);
  if (existing) {
    return ctx.reply('اکانت تست قبلاً برای این حساب فعال شده است.', mainMenu());
  }

  const country = COUNTRIES.find((item) => item.code === TRIAL_ACCOUNT.countryCode);
  if (!country || !Number.isInteger(country.inboundId) || country.inboundId <= 0) {
    return ctx.reply('تنظیمات اکانت تست کامل نیست. بعداً دوباره تلاش کن.', mainMenu());
  }

  const username = `${TRIAL_ACCOUNT.usernamePrefix}_${ctx.from.id}`.slice(0, 32);

  try {
    const result = await provisionClient({
      email: username,
      inboundId: country.inboundId,
      telegramId: Number(ctx.from.id),
      durationDays: TRIAL_ACCOUNT.durationDays,
      trafficGb: TRIAL_ACCOUNT.trafficGb,
      limitIp: TRIAL_ACCOUNT.limitIp,
      countryCode: country.code,
    });

    // ثبت بلافاصله پس از ساخت موفق، تا هر کاربر در هر کمپین فقط یک تست بگیرد.
    saveTrialAccount({ userId: ctx.from.id, username: result.email, subId: result.subId, inboundId: result.inboundId, campaignId: TRIAL_ACCOUNT.campaignId });

    await ctx.reply(`🎁 اکانت تست فعال شد.\n\n📦 حجم: ${TRIAL_ACCOUNT.trafficLabel}\n⏳ اعتبار: ${TRIAL_ACCOUNT.durationDays} روز\n👤 نام کاربری: ${result.email}`);
    await sendLink(ctx.from.id, texts.delivery.vlessTitle, result.vlessUrl, '📋 کپی خودکار لینک VLESS');
    await sendSubscriptionAddLink(ctx.from.id, result.subscriptionUrl);
    await ctx.reply('برای مشاهدهٔ حجم و زمان باقی‌مانده لینک اشتراک را اضافه کن.', mainMenu());
  } catch (error) {
    console.error('Trial provisioning failed:', error);
    await ctx.reply('ساخت اکانت تست انجام نشد؛ چند دقیقهٔ دیگر دوباره تلاش کن.', mainMenu());
  }
}

bot.action('claim_trial', async (ctx) => {
  await ctx.answerCbQuery();
  await claimTrial(ctx);
});

// --------------------------------------------------
// Purchase: country
// --------------------------------------------------

async function showProductSelector(ctx) {
  clearPurchase(ctx);

  const countries = [
    ...new Map(
      getPurchasableProducts().map((product) => [
        product.country,
        {
          code: product.country,
          name: product.countryName,
          flag: product.name.split(' ')[0],
        },
      ]),
    ).values(),
  ];

  ctx.session.purchase = { step: 'country' };
  await ctx.reply(
    '🌍 لوکیشن موردنظرت رو انتخاب کن:',
    Markup.inlineKeyboard([
      ...countries.map((country) => [Markup.button.callback(`${country.flag} ${country.name}`, `country_${country.code}`)]),
      [backButton('🔙 بازگشت به منوی اصلی')],
    ]),
  );
}

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery();
  if (await ensureRequiredChannelMembership(ctx)) await showProductSelector(ctx);
});

bot.action(/^country_([A-Z]{2,8})$/, async (ctx) => {
  await ctx.answerCbQuery();

  const country = ctx.match[1];

  if (!isCountryEnabled(country)) {
    return ctx.reply('این لوکیشن فعلاً در دسترس نیست.');
  }

  ctx.session.purchase = {
    country,
    step: 'duration',
  };

  const countryName = COUNTRIES.find((item) => item.code === country)?.name;

  if (!countryName) return ctx.reply('این کشور در دسترس نیست.');

  const durations = [
    ...new Set(
      getPurchasableProducts()
        .filter((product) => product.country === country)
        .map((product) => product.months),
    ),
  ];

  await ctx.reply(
    `🌍 کشور انتخاب‌شده: ${countryName}\n\n` + `⏳ مدت اشتراک را انتخاب کن:`,
    Markup.inlineKeyboard([...durations.map((months) => [Markup.button.callback(`${months} ماهه`, `duration_${country}_${months}`)]), [backButton('🔙 بازگشت', 'show_products')]]),
  );
});

// --------------------------------------------------
// Purchase: duration
// --------------------------------------------------

bot.action(/^duration_([A-Z]{2,8})_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const country = ctx.match[1];
  const months = Number(ctx.match[2]);

  const purchase = ctx.session.purchase;

  if (!purchase || purchase.country !== country) {
    return ctx.reply('مرحله خرید معتبر نیست. دوباره شروع کن.');
  }

  purchase.months = months;
  purchase.step = 'traffic';

  const countryName = getPurchasableProducts().find((product) => product.country === country)?.countryName;

  const availableProducts = getPurchasableProducts().filter((product) => product.country === country && Number(product.months) === months);

  const buttons = availableProducts.map((product) => [Markup.button.callback(`${product.trafficLabel} | ${formatPrice(product.price)}`, `select_plan_${product.id}`)]);

  buttons.push([backButton('🔙 بازگشت به لوکیشن', 'show_products')]);

  await ctx.reply(`🌍 کشور: ${countryName}\n` + `⏳ مدت: ${months} ماه\n\n` + `📦 حجم موردنظرت رو انتخاب کن:`, Markup.inlineKeyboard(buttons));
});

// --------------------------------------------------
// Purchase: plan
// --------------------------------------------------

bot.action(/^select_plan_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const product = getProduct(ctx.match[1]);
  const purchase = ctx.session.purchase;

  if (
    !product ||
    !isCountryEnabled(product.country) ||
    !purchase ||
    purchase.country !== product.country ||
    Number(purchase.months) !== Number(product.months) ||
    purchase.step !== 'traffic'
  ) {
    return ctx.reply('سرویسی که انتخاب کردی در حال حاضر در دسترس نیست 😔 , در حال بررسی موضـوع هستیـم.');
  }

  purchase.productId = product.id;
  delete purchase.discountCode;
  purchase.step = 'limit';

  await ctx.reply(
    ` سرویس انتخاب شد:\n\n` +
      `🌍 کشور: ${product.countryName}\n` +
      `⏳ مدت: ${product.duration}\n` +
      `📦 حجم: ${product.trafficLabel}\n` +
      `💰 قیمت پایه (۱ کاربره): ${formatPrice(product.price)}\n\n` +
      `👥 تعداد کاربران مجاز هم‌زمان را انتخاب کن:`,
    Markup.inlineKeyboard([
      ...USER_LIMIT_OPTIONS.map((option) => [Markup.button.callback(option.label, `limit_${option.value}`)]),
      [backButton('🔙 بازگشت به انتخاب حجم', `duration_${product.country}_${product.months}`)],
      [backButton('لغو خرید', 'cancel_purchase')],
    ]),
  );
});

// --------------------------------------------------
// Purchase: limit
// --------------------------------------------------

bot.action(/^limit_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session.purchase;

  if (!purchase || purchase.step !== 'limit') {
    return ctx.reply('مرحله خرید منقضی شده, دوباره شروع کن.');
  }

  if (!USER_LIMIT_OPTIONS.some((option) => option.value === Number(ctx.match[1]))) {
    return ctx.reply('تعداد کاربران انتخاب‌شده معتبر نیست.');
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

  if (!canCreateNewUsername(ctx.from.id)) {
    return ctx.reply(`حداکثر ${MAX_SERVICE_PROFILES} Username یکتا مجاز است. یکی از Usernameهای قبلی را انتخاب کن.`);
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

  if (!purchase.profileInboundId && !canCreateNewUsername(ctx.from.id)) {
    return ctx.reply(`حداکثر ${MAX_SERVICE_PROFILES} Username یکتا مجاز است. یکی از Usernameهای قبلی را انتخاب کن.`);
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

  if (!purchase || !['choose_username', 'new_username', 'username'].includes(purchase.step)) {
    return ctx.reply('مرحله انتخاب Username معتبر نیست.');
  }

  if (!purchase.profileInboundId && !canCreateNewUsername(ctx.from.id)) {
    return ctx.reply(`حداکثر ${MAX_SERVICE_PROFILES} Username یکتا مجاز است. یکی از Usernameهای قبلی را انتخاب کن.`);
  }

  purchase.step = 'awaiting_username';

  await ctx.reply(texts.username.prompt);
});

bot.action('enter_discount', async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session?.purchase;
  if (!purchase || purchase.step !== 'confirm') {
    return ctx.reply('مرحلهٔ ثبت تخفیف معتبر نیست.');
  }

  purchase.step = 'awaiting_discount_code';
  await ctx.reply('🎟 کد تخفیف را ارسال کن یا /cancel را بزن.');
});

bot.action('remove_discount', async (ctx) => {
  await ctx.answerCbQuery();

  const purchase = ctx.session?.purchase;
  if (!purchase || !purchase.productId) return ctx.reply('فرایند خرید پیدا نشد.');

  delete purchase.discountCode;
  await showInvoice(ctx);
});

bot.on('text', async (ctx, next) => {
  const keyboardPurchase = ctx.session?.purchase;
  const text = ctx.message.text.trim();

  if (ctx.session?.support) {
    if (text.startsWith('/')) return next();

    const supportChatId = String(SUPPORT.chatId || '').trim();
    if (!supportChatId) {
      delete ctx.session.support;
      return ctx.reply(
        'ارسال پیام از داخل ربات فعلاً فعال نیست. لطفاً مستقیم با پشتیبانی ارتباط بگیر.',
        Markup.inlineKeyboard([[Markup.button.url('💬 پیام مستقیم به پشتیبانی', SUPPORT.directUrl)]]),
      );
    }

    try {
      await bot.telegram.forwardMessage(supportChatId, ctx.chat.id, ctx.message.message_id);
      delete ctx.session.support;
      return ctx.reply('✅ پیامت برای پشتیبانی ارسال شد. به‌زودی پاسخ می‌دهیم.', mainMenu());
    } catch (error) {
      console.error('Support message forwarding failed:', error);
      return ctx.reply('ارسال پیام به پشتیبانی انجام نشد. لطفاً دوباره تلاش کن یا مستقیم پیام بده.');
    }
  }

  if (keyboardPurchase?.step === 'awaiting_discount_code') {
    const product = getProduct(keyboardPurchase.productId);
    const pricing = product ? getPurchasePricing({ ...keyboardPurchase, discountCode: text }, product) : null;

    if (!pricing?.discount) {
      return ctx.reply('این کد تخفیف معتبر نیست یا برای پلن انتخاب‌شده فعال نیست. دوباره وارد کن یا /cancel را بزن.');
    }

    keyboardPurchase.discountCode = pricing.discount.code;
    return showInvoice(ctx);
  }

  if (keyboardPurchase?.step === 'keyboard_country') {
    if (text === '🔙 بازگشت به منوی اصلی') {
      clearPurchase(ctx);
      return ctx.reply('منوی اصلی:', mainMenu());
    }
    const country = COUNTRIES.find((item) => item.enabled !== false && `${item.flag} ${item.name}` === text);
    if (country) {
      keyboardPurchase.country = country.code;
      keyboardPurchase.step = 'keyboard_duration';
      const months = [
        ...new Set(
          getPurchasableProducts()
            .filter((item) => item.country === country.code)
            .map((item) => item.months),
        ),
      ];
      return ctx.reply(`🌍 کشور انتخاب‌شده: ${country.name}\n\n⏳ مدت اشتراک را انتخاب کن:`, fullWidthKeyboard([...months.map((value) => `${value} ماهه`), '🔙 بازگشت به لوکیشن']));
    }
  }
  if (keyboardPurchase?.step === 'keyboard_duration') {
    if (text === '🔙 بازگشت به لوکیشن') return showProductSelector(ctx);
    const months = Number(text.replace(/[^0-9]/g, ''));
    const available = getPurchasableProducts().filter((item) => item.country === keyboardPurchase.country && item.months === months);
    if (available.length) {
      keyboardPurchase.months = months;
      keyboardPurchase.step = 'keyboard_plan';
      return ctx.reply('📦 حجم موردنظرت را انتخاب کن:', fullWidthKeyboard([...available.map((item) => `${item.trafficLabel} | ${formatPrice(item.price)}`), '🔙 بازگشت به مدت']));
    }
  }
  if (keyboardPurchase?.step === 'keyboard_plan') {
    if (text === '🔙 بازگشت به مدت') {
      keyboardPurchase.step = 'keyboard_duration';
      const months = [
        ...new Set(
          getPurchasableProducts()
            .filter((item) => item.country === keyboardPurchase.country)
            .map((item) => item.months),
        ),
      ];
      return ctx.reply('⏳ مدت اشتراک را انتخاب کن:', fullWidthKeyboard([...months.map((value) => `${value} ماهه`), '🔙 بازگشت به لوکیشن']));
    }
    const product = getPurchasableProducts().find(
      (item) => item.country === keyboardPurchase.country && item.months === keyboardPurchase.months && `${item.trafficLabel} | ${formatPrice(item.price)}` === text,
    );
    if (product) {
      keyboardPurchase.productId = product.id;
      delete keyboardPurchase.discountCode;
      keyboardPurchase.step = 'limit';
      return ctx.reply('👥 تعداد کاربران مجاز هم‌زمان را انتخاب کن:', fullWidthKeyboard([...USER_LIMIT_OPTIONS.map((item) => item.label), '🔙 بازگشت به انتخاب حجم']));
    }
  }
  if (keyboardPurchase?.step === 'limit' && text === '🔙 بازگشت به انتخاب حجم') {
    keyboardPurchase.step = 'keyboard_plan';
    const available = getPurchasableProducts().filter((item) => item.country === keyboardPurchase.country && item.months === keyboardPurchase.months);
    return ctx.reply('📦 حجم موردنظرت را انتخاب کن:', fullWidthKeyboard([...available.map((item) => `${item.trafficLabel} | ${formatPrice(item.price)}`), '🔙 بازگشت به مدت']));
  }
  if (keyboardPurchase?.step === 'limit') {
    const limit = USER_LIMIT_OPTIONS.find((item) => item.label === text);
    if (limit) {
      keyboardPurchase.limitIp = limit.value;
      return showUsernameOptions(ctx);
    }
  }

  if (ctx.session?.inquiry) {
    const link = ctx.message.text.trim();
    if (link.startsWith('/')) return next();

    const identifier = getLinkIdentifier(link);
    if (!identifier) return ctx.reply('❌ لینک معتبر نیست. لینک VLESS یا لینک اشتراک را کامل ارسال کن.');

    try {
      const client = await findClientByIdentifier(identifier);
      if (!client) return ctx.reply('❌ لینک معتبر نیست یا سرویس آن دیگر وجود ندارد.');

      const total = Number(client.totalGB ?? client.total ?? 0);
      const used = Number(client.up || 0) + Number(client.down || 0);
      const country = getProductByInbound(client.inboundId)?.countryName || 'نامشخص';
      const traffic =
        total > 0
          ? `📦 حجم: ${formatBytes(used)} مصرف‌شده از ${formatBytes(total)}\n📉 حجم باقی‌مانده: ${formatBytes(total - used)}`
          : `📦 حجم: نامحدود\n📉 مصرف‌شده: ${formatBytes(used)}`;

      delete ctx.session.inquiry;
      return ctx.reply(
        `✅ استعلام سرویس\n\n👤 نام کاربری: ${client.email || 'نامشخص'}\n🌍 لوکیشن: ${country}\n${traffic}\n⏳ زمان باقی‌مانده: ${getRemainingDays(client.expiryTime)} روز\n👥 تعداد دستگاه مجاز: ${getUserLimitLabel(client.limitIp)}\n📡 وضعیت: ${client.enable ? 'فعال' : 'غیرفعال'}`,
        mainMenu(),
      );
    } catch (error) {
      console.error('Inquiry failed:', error);
      return ctx.reply('استعلام سرویس انجام نشد؛ دوباره تلاش کن.');
    }
  }

  const purchase = ctx.session?.purchase;

  if (!purchase || purchase.step !== 'awaiting_username') {
    return next();
  }

  if (!canCreateNewUsername(ctx.from.id)) {
    return ctx.reply(`حداکثر ${MAX_SERVICE_PROFILES} Username یکتا مجاز است. یکی از Usernameهای قبلی را انتخاب کن.`);
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

  if (!(await ensureRequiredChannelMembership(ctx))) {
    return ctx.answerCbQuery('ابتدا عضو کانال شو.', { show_alert: true });
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
  } else if (!canCreateNewUsername(ctx.from.id)) {
    return ctx.answerCbQuery(`حداکثر ${MAX_SERVICE_PROFILES} Username یکتا مجاز است.`, { show_alert: true });
  }

  const selectedInboundId = Number(product.inboundId);

  const extraPrice = getPriceExtra(purchase.limitIp);
  const pricing = getPurchasePricing(purchase, product);

  const orderProduct = {
    ...product,
    price: pricing.finalPrice,
    basePrice: Number(product.price),
    extraPrice,
    inboundId: selectedInboundId,
    country: product.country,
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

bot.action(/^edit_order_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const orderId = Number(ctx.match[1]);
  const order = getOrder(orderId);

  if (!order || Number(order.telegram_user_id) !== Number(ctx.from.id)) {
    return ctx.reply('این سفارش پیدا نشد.');
  }

  if (!['awaiting_payment', 'rejected'].includes(order.status)) {
    return ctx.reply('پس از ارسال رسید، سفارش دیگر قابل ویرایش نیست.');
  }

  // سفارش قبلی لغو و مسیر ویرایش با همان کشور آغاز می‌شود تا مبلغ و تنظیمات جدید شفاف باشند.
  if (!cancelUnpaidOrder(orderId, ctx.from.id)) {
    return ctx.reply('ویرایش سفارش انجام نشد؛ دوباره تلاش کن.');
  }

  ctx.session.purchase = { country: order.country, step: 'duration' };
  const country = COUNTRIES.find((item) => item.code === order.country);

  if (!country || !isCountryEnabled(country.code)) {
    clearPurchase(ctx);
    return ctx.reply('کشور سفارش قبلی دیگر در دسترس نیست.');
  }

  const durations = [
    ...new Set(
      getPurchasableProducts()
        .filter((product) => product.country === country.code)
        .map((product) => product.months),
    ),
  ];

  await ctx.reply(
    `سفارش ${orderId} لغو شد و می‌توانی نسخهٔ جدید آن را بسازی.\n\n⏳ مدت اشتراک را انتخاب کن:`,
    Markup.inlineKeyboard([
      ...durations.map((months) => [Markup.button.callback(`${months} ماهه`, `duration_${country.code}_${months}`)]),
      [backButton('لغو خرید', 'cancel_purchase')],
    ]),
  );
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
        [successButton('تأیید پرداخت', `payment_approve_${order.id}`)],
        [dangerButton('رد پرداخت', `payment_reject_${order.id}`)],
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

bot.action('my_services', async (ctx) => {
  await ctx.answerCbQuery();

  const orders = getUserOrders(ctx.from.id).filter((order) => order.status === 'active');
  const trial = getTrialAccount(ctx.from.id);

  if (!orders.length && !trial) {
    return ctx.reply('🖥 هنوز سرویس فعالی نداری.', Markup.inlineKeyboard([[backButton()]]));
  }

  const paidServices = orders.map((order) => {
    const product = getProduct(order.product_id);
    return `🖥 سرویس #${order.id}\n🌍 ${order.country || product?.countryName || 'نامشخص'}\n👤 ${order.xui_email}\n📦 ${order.unlimited ? 'نامحدود' : `${order.traffic_gb} گیگابایت`}\n⏳ ${order.duration_months} ماه`;
  });
  const trialService = trial ? [`🎁 اکانت تست\n👤 ${trial.xui_email}\n📦 ${TRIAL_ACCOUNT.trafficLabel}`] : [];

  await ctx.reply([...paidServices, ...trialService].join('\n\n'), Markup.inlineKeyboard([[backButton()]]));
});

bot.action('my_orders', async (ctx) => {
  await ctx.answerCbQuery();
  await showMyOrders(ctx, Markup.inlineKeyboard([[backButton()]]));
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
  delete ctx.session.inquiry;
  delete ctx.session.support;

  await ctx.reply('منوی اصلی:', mainMenu());
});

async function startSupport(ctx) {
  ctx.session.support = true;

  await ctx.reply(
    `سلام و وقت بخیر 🌹\n\n` +
      `اگر درباره سرویس‌هات سوالی داری یا با مشکلی مواجه شدی، تیم پشتیبانی ویپانت آماده پاسخگویی به شماست.\n\n` +
      `🕘 ساعت پاسخگویی پشتیبانی: هر روز از ساعت ۹ صبح تا ۱۰ شب\n\n` +
      `📩 می‌تونی سوال یا درخواستت رو همین‌جا از طریق ربات ارسال کنی تا در اولین فرصت بررسی و پاسخ داده بشه.\n\n` +
      `💬 برای ارتباط سریع‌تر و دریافت پشتیبانی مستقیم، از طریق آیدی زیر با ما در ارتباط باش:\n\n` +
      `🆔 @vipanet\n\n` +
      `منتظر پیام‌هات هستیم ❤️\n\n` +
      `✍️ پیامت رو ارسال کن یا برای بازگشت، دکمه «❌ انصراف» رو بزن.`,
    Markup.inlineKeyboard([[Markup.button.url('💬 ارتباط مستقیم با پشتیبانی', SUPPORT.directUrl)], [dangerButton('انصراف', 'support_cancel')]]),
  );
}

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  await startSupport(ctx);
});

bot.action('support_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  delete ctx.session.support;
  await ctx.reply('پشتیبانی لغو شد.', mainMenu());
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

    // تنظیم منوی تلگرام برای اجرای بات ضروری نیست. اگر تلگرام این API را
    // rate-limit کند، polling بات باید همچنان فعال بماند.
    try {
      await bot.telegram.setMyCommands([{ command: 'start', description: 'شروع' }]);
      await bot.telegram.callApi('setChatMenuButton', {
        menu_button: { type: 'commands' },
      });
    } catch (error) {
      const retryAfter = error?.response?.parameters?.retry_after;
      console.warn(`Telegram menu setup was skipped${retryAfter ? `; retry after ${retryAfter}s` : ''}: ${error.message}`);
    }
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

startBot();
