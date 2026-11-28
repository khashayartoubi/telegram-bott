const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "../../data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, "store.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// Telegraf's default store exists only in process memory. Store sessions in
// SQLite so an in-progress purchase survives a bot or PM2 restart.
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_sessions (
    session_key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const sessionStatements = {
  get: db.prepare("SELECT value FROM bot_sessions WHERE session_key = ?"),
  set: db.prepare(`
    INSERT INTO bot_sessions (session_key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `),
  delete: db.prepare("DELETE FROM bot_sessions WHERE session_key = ?"),
};

const sessionStore = {
  get(key) {
    const row = sessionStatements.get.get(String(key));
    if (!row) return undefined;

    try {
      return JSON.parse(row.value);
    } catch {
      sessionStatements.delete.run(String(key));
      return undefined;
    }
  },
  set(key, value) {
    sessionStatements.set.run(String(key), JSON.stringify(value));
  },
  delete(key) {
    sessionStatements.delete.run(String(key));
  },
};

// --------------------------------------------------
// Orders table
// --------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL,
    telegram_username TEXT,
    product_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_payment',
    xui_email TEXT,
    sub_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// A trial may only be claimed once by each Telegram account.
db.exec(`
  CREATE TABLE IF NOT EXISTS trial_accounts (
    telegram_user_id INTEGER PRIMARY KEY,
    xui_email TEXT NOT NULL UNIQUE,
    sub_id TEXT NOT NULL,
    inbound_id INTEGER NOT NULL,
    campaign_id INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

if (!getColumns('trial_accounts').includes('campaign_id')) {
  db.exec('ALTER TABLE trial_accounts ADD COLUMN campaign_id INTEGER NOT NULL DEFAULT 1');
}

function getColumns(tableName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => column.name);
}

const migrations = {
  payment_photo_file_id: "TEXT",
  payment_rejection_reason: "TEXT",
  limit_ip: "INTEGER NOT NULL DEFAULT 0",
  price: "INTEGER",
  traffic_gb: "INTEGER",
  duration_months: "INTEGER",
  unlimited: "INTEGER NOT NULL DEFAULT 0",
  country: "TEXT",
  payment_status: "TEXT NOT NULL DEFAULT 'unpaid'",
  provision_status: "TEXT NOT NULL DEFAULT 'not_started'",
  inbound_id: "INTEGER",
};

for (const [column, definition] of Object.entries(migrations)) {
  if (!getColumns("orders").includes(column)) {
    db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
  }
}

// --------------------------------------------------
// Remove UNIQUE constraint from orders.xui_email
// --------------------------------------------------

function hasUniqueEmailConstraint() {
  const indexes = db.prepare("PRAGMA index_list(orders)").all();

  for (const index of indexes) {
    if (!index.unique) continue;

    const columns = db.prepare(`PRAGMA index_info("${index.name}")`).all();

    if (columns.length === 1 && columns[0].name === "xui_email") {
      return true;
    }
  }

  return false;
}

if (hasUniqueEmailConstraint()) {
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE orders_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        telegram_username TEXT,
        product_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting_payment',
        xui_email TEXT,
        sub_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        payment_photo_file_id TEXT,
        payment_rejection_reason TEXT,
        limit_ip INTEGER NOT NULL DEFAULT 0,
        price INTEGER,
        traffic_gb INTEGER,
        duration_months INTEGER,
        unlimited INTEGER NOT NULL DEFAULT 0,
        country TEXT,
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        provision_status TEXT NOT NULL DEFAULT 'not_started',
        inbound_id INTEGER
      );
    `);

    const oldColumns = getColumns("orders");
    const newColumns = getColumns("orders_new");

    const commonColumns = newColumns.filter((column) =>
      oldColumns.includes(column),
    );

    const columns = commonColumns.map((column) => `"${column}"`).join(", ");

    db.exec(`
      INSERT INTO orders_new (${columns})
      SELECT ${columns}
      FROM orders;
    `);

    db.exec(`
      DROP TABLE orders;
      ALTER TABLE orders_new RENAME TO orders;
    `);
  });

  rebuild();
}

// --------------------------------------------------
// Service profiles
// --------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS service_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL,
    xui_email TEXT NOT NULL UNIQUE,
    sub_id TEXT,
    inbound_id INTEGER,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_service_profiles_user
  ON service_profiles(telegram_user_id);
`);

// Migrate existing usernames into service_profiles.
// Older orders may not have inbound_id. It will be filled
// when the user next purchases or the service is provisioned.

const migrateProfiles = db.transaction(() => {
  const oldOrders = db
    .prepare(
      `
    SELECT *
    FROM orders
    WHERE xui_email IS NOT NULL
      AND xui_email != ''
    ORDER BY id ASC
  `,
    )
    .all();

  const insertProfile = db.prepare(`
    INSERT INTO service_profiles (
      telegram_user_id,
      xui_email,
      sub_id,
      inbound_id,
      is_default
    )
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(xui_email) DO NOTHING
  `);

  for (const order of oldOrders) {
    insertProfile.run(
      order.telegram_user_id,
      order.xui_email,
      order.sub_id || null,
      order.inbound_id || null,
    );
  }

  const users = db
    .prepare(
      `
    SELECT DISTINCT telegram_user_id
    FROM service_profiles
  `,
    )
    .all();

  const setDefault = db.prepare(`
    UPDATE service_profiles
    SET is_default = 0
    WHERE telegram_user_id = ?
  `);

  const chooseDefault = db.prepare(`
    UPDATE service_profiles
    SET is_default = 1
    WHERE id = (
      SELECT id
      FROM service_profiles
      WHERE telegram_user_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    )
  `);

  for (const user of users) {
    setDefault.run(user.telegram_user_id);
    chooseDefault.run(user.telegram_user_id);
  }
});

migrateProfiles();

// --------------------------------------------------
// Orders
// --------------------------------------------------

function createOrder({
  userId,
  telegramUsername,
  product,
  xuiEmail,
  limitIp,
  inboundId,
}) {
  if (!product || !Number.isInteger(Number(product.id))) {
    throw new Error("Invalid product");
  }

  const result = db
    .prepare(
      `
    INSERT INTO orders (
      telegram_user_id,
      telegram_username,
      product_id,
      status,
      xui_email,
      limit_ip,
      price,
      traffic_gb,
      duration_months,
      unlimited,
      country,
      payment_status,
      provision_status,
      inbound_id
    )
    VALUES (
      @userId,
      @telegramUsername,
      @productId,
      'awaiting_payment',
      @xuiEmail,
      @limitIp,
      @price,
      @trafficGb,
      @durationMonths,
      @unlimited,
      @country,
      'unpaid',
      'not_started',
      @inboundId
    )
  `,
    )
    .run({
      userId: Number(userId),
      telegramUsername: telegramUsername || null,
      productId: Number(product.id),
      xuiEmail,
      limitIp: Number(limitIp),
      price: Number(product.price),
      trafficGb: Number(product.trafficGb || 0),
      durationMonths: Number(product.months),
      unlimited: product.unlimited ? 1 : 0,
      country: product.country || null,
      inboundId: Number(inboundId || product.inboundId),
    });

  return getOrder(result.lastInsertRowid);
}

function getOrder(orderId) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(orderId));
}

function getUserOrders(userId) {
  return db
    .prepare(
      `
    SELECT *
    FROM orders
    WHERE telegram_user_id = ?
    ORDER BY id DESC
  `,
    )
    .all(Number(userId));
}

function isUsernameTaken(username) {
  return Boolean(
    db
      .prepare(
        `
      SELECT 1
      FROM service_profiles
      WHERE xui_email = ?
      UNION
      SELECT 1
      FROM orders
      WHERE xui_email = ?
        AND status != 'cancelled'
      LIMIT 1
    `,
      )
      .get(username, username),
  );
}

function updateOrder(orderId, fields) {
  const allowed = [
    "status",
    "xui_email",
    "sub_id",
    "payment_photo_file_id",
    "payment_rejection_reason",
    "payment_status",
    "provision_status",
    "inbound_id",
    "limit_ip",
    "price",
    "traffic_gb",
    "duration_months",
    "unlimited",
    "country",
  ];

  const entries = Object.entries(fields).filter(([key]) =>
    allowed.includes(key),
  );

  if (!entries.length) {
    return getOrder(orderId);
  }

  const setClause = entries.map(([key]) => `"${key}" = @${key}`).join(", ");

  const values = Object.fromEntries(entries);
  values.id = Number(orderId);

  db.prepare(
    `
    UPDATE orders
    SET ${setClause},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `,
  ).run(values);

  return getOrder(orderId);
}

function submitPaymentReceipt(orderId, userId, fileId) {
  const result = db
    .prepare(
      `
    UPDATE orders
    SET status = 'payment_review',
        payment_status = 'unpaid',
        payment_photo_file_id = ?,
        payment_rejection_reason = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND telegram_user_id = ?
      AND status IN ('awaiting_payment', 'rejected')
      AND payment_status IN ('unpaid', 'rejected')
  `,
    )
    .run(fileId, Number(orderId), Number(userId));

  return result.changes === 1;
}

function approvePayment(orderId) {
  const result = db
    .prepare(
      `
    UPDATE orders
    SET payment_status = 'paid',
        status = 'processing',
        provision_status = 'pending',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'payment_review'
      AND payment_status = 'unpaid'
  `,
    )
    .run(Number(orderId));

  return result.changes === 1;
}

function rejectPayment(orderId, reason) {
  const result = db
    .prepare(
      `
    UPDATE orders
    SET payment_status = 'rejected',
        status = 'rejected',
        payment_rejection_reason = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'payment_review'
      AND payment_status = 'unpaid'
  `,
    )
    .run(reason, Number(orderId));

  return result.changes === 1;
}

function claimProvision(orderId) {
  const result = db
    .prepare(
      `
    UPDATE orders
    SET provision_status = 'processing',
        status = 'processing',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND payment_status = 'paid'
      AND provision_status IN ('pending', 'failed')
  `,
    )
    .run(Number(orderId));

  return result.changes === 1;
}

function cancelUnpaidOrder(orderId, userId) {
  const result = db
    .prepare(
      `
    UPDATE orders
    SET status = 'cancelled',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND telegram_user_id = ?
      AND status IN ('awaiting_payment', 'rejected')
      AND payment_status IN ('unpaid', 'rejected')
  `,
    )
    .run(Number(orderId), Number(userId));

  return result.changes === 1;
}

function getPendingOrders() {
  return db
    .prepare(
      `
    SELECT *
    FROM orders
    WHERE status IN (
      'awaiting_payment',
      'payment_review',
      'processing',
      'failed'
    )
    ORDER BY id DESC
  `,
    )
    .all();
}

// --------------------------------------------------
// Service profiles
// --------------------------------------------------

function getUserProfiles(userId) {
  return db
    .prepare(
      `
    SELECT *
    FROM service_profiles
    WHERE telegram_user_id = ?
    ORDER BY is_default DESC, updated_at DESC, id DESC
  `,
    )
    .all(Number(userId));
}

function getDefaultProfile(userId) {
  return db
    .prepare(
      `
    SELECT *
    FROM service_profiles
    WHERE telegram_user_id = ?
    ORDER BY is_default DESC, updated_at DESC, id DESC
    LIMIT 1
  `,
    )
    .get(Number(userId));
}

function getUserProfile(userId, username) {
  return db
    .prepare(
      `
    SELECT *
    FROM service_profiles
    WHERE telegram_user_id = ?
      AND xui_email = ?
    LIMIT 1
  `,
    )
    .get(Number(userId), username);
}

function setDefaultProfile(userId, username) {
  const profile = getUserProfile(userId, username);

  if (!profile) return false;

  const transaction = db.transaction(() => {
    db.prepare(
      `
      UPDATE service_profiles
      SET is_default = 0
      WHERE telegram_user_id = ?
    `,
    ).run(Number(userId));

    db.prepare(
      `
      UPDATE service_profiles
      SET is_default = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
        AND xui_email = ?
    `,
    ).run(Number(userId), username);
  });

  transaction();

  return true;
}

function saveServiceProfile({ userId, username, subId, inboundId }) {
  const existing = db
    .prepare(
      `
    SELECT *
    FROM service_profiles
    WHERE xui_email = ?
  `,
    )
    .get(username);

  if (existing && Number(existing.telegram_user_id) !== Number(userId)) {
    throw new Error("This username belongs to another Telegram user");
  }

  const transaction = db.transaction(() => {
    const userProfiles = getUserProfiles(userId);

    if (!userProfiles.length) {
      db.prepare(
        `
        INSERT INTO service_profiles (
          telegram_user_id,
          xui_email,
          sub_id,
          inbound_id,
          is_default
        )
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(xui_email) DO UPDATE SET
          sub_id = excluded.sub_id,
          inbound_id = excluded.inbound_id,
          updated_at = CURRENT_TIMESTAMP
      `,
      ).run(Number(userId), username, subId || null, Number(inboundId));
    } else {
      db.prepare(
        `
        INSERT INTO service_profiles (
          telegram_user_id,
          xui_email,
          sub_id,
          inbound_id,
          is_default
        )
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(xui_email) DO UPDATE SET
          sub_id = excluded.sub_id,
          inbound_id = excluded.inbound_id,
          updated_at = CURRENT_TIMESTAMP
      `,
      ).run(Number(userId), username, subId || null, Number(inboundId));

      db.prepare(
        `
        UPDATE service_profiles
        SET is_default = 0
        WHERE telegram_user_id = ?
      `,
      ).run(Number(userId));

      db.prepare(
        `
        UPDATE service_profiles
        SET is_default = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE telegram_user_id = ?
          AND xui_email = ?
      `,
      ).run(Number(userId), username);
    }
  });

  transaction();

  return getUserProfile(userId, username);
}

module.exports = {
  sessionStore,
  createOrder,
  getOrder,
  getUserOrders,
  isUsernameTaken,
  updateOrder,
  submitPaymentReceipt,
  approvePayment,
  rejectPayment,
  claimProvision,
  cancelUnpaidOrder,
  getPendingOrders,

  getUserProfiles,
  getDefaultProfile,
  getUserProfile,
  setDefaultProfile,
  saveServiceProfile,
  getTrialAccount(userId, campaignId = 1) {
    return db.prepare('SELECT * FROM trial_accounts WHERE telegram_user_id = ? AND campaign_id = ?').get(Number(userId), Number(campaignId));
  },
  saveTrialAccount({ userId, username, subId, inboundId, campaignId = 1 }) {
    db.prepare(`INSERT INTO trial_accounts (telegram_user_id, xui_email, sub_id, inbound_id, campaign_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET xui_email = excluded.xui_email, sub_id = excluded.sub_id, inbound_id = excluded.inbound_id, campaign_id = excluded.campaign_id, created_at = CURRENT_TIMESTAMP`)
      .run(Number(userId), username, subId, Number(inboundId), Number(campaignId));
    return db.prepare('SELECT * FROM trial_accounts WHERE telegram_user_id = ? AND campaign_id = ?').get(Number(userId), Number(campaignId));
  },
};
