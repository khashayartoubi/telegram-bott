const crypto = require('crypto');

const BASE_URL = process.env.XUI_BASE_URL;
const API_TOKEN = process.env.XUI_API_TOKEN;
const SUBSCRIPTION_BASE_URL = process.env.XUI_SUBSCRIPTION_BASE_URL;

if (!BASE_URL || !API_TOKEN || !SUBSCRIPTION_BASE_URL) {
  throw new Error('Missing 3x-ui environment variables');
}

const baseUrl = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;

function getSubscriptionBaseUrl() {
  try {
    // A trailing slash is required so the subscription id is appended to the
    // configured path instead of replacing its final segment.
    return new URL(`${SUBSCRIPTION_BASE_URL.replace(/\/+$/, '')}/`);
  } catch {
    throw new Error(
      'XUI_SUBSCRIPTION_BASE_URL is invalid. It must have exactly one port, for example http://host:2096/sub/',
    );
  }
}

function createClientRemark(countryCode, username) {
  return `${String(countryCode || 'VPN').toUpperCase()}-${username}`;
}

function withRemark(vlessUrl, remark) {
  try {
    const url = new URL(vlessUrl);
    url.hash = remark;
    return url.toString();
  } catch {
    // The panel has already returned a usable VLESS link. Preserve it if it
    // uses a non-standard format rather than preventing delivery.
    return vlessUrl;
  }
}

async function request(endpoint, options = {}) {
  const url = new URL(endpoint.replace(/^\/+/, ''), baseUrl);

  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
      Authorization: `Bearer ${API_TOKEN}`,
    },
    signal: AbortSignal.timeout(20000),
  });

  const rawBody = await response.text();

  if (!rawBody.trim()) {
    throw new Error(`3x-ui returned empty response. HTTP ${response.status}`);
  }

  let data;

  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`Invalid 3x-ui response: ${rawBody.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`3x-ui HTTP ${response.status}: ${data.msg || 'Request failed'}`);
  }

  return data;
}
function assertSuccess(data, operation) {
  if (data.success !== true) {
    throw new Error(`${operation} failed: ${data.msg || 'Unknown error'}`);
  }

  return data.obj;
}

function parseInboundSettings(inbound) {
  if (!inbound.settings) return {};

  if (typeof inbound.settings === 'object') {
    return inbound.settings;
  }

  try {
    return JSON.parse(inbound.settings);
  } catch {
    return {};
  }
}

async function getInbounds() {
  const data = await request('panel/api/inbounds/list');

  return assertSuccess(data, 'Get inbounds') || [];
}

async function findClient(email) {
  const inbounds = await getInbounds();

  for (const inbound of inbounds) {
    const settings = parseInboundSettings(inbound);
    const clients = settings.clients || [];

    const client = clients.find((item) => item.email === email);

    if (client) {
      return {
        ...client,
        inboundId: Number(inbound.id),
        inbound,
      };
    }
  }

  return null;
}

async function getClient(email) {
  return findClient(email);
}

async function findClientByIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;

  const inbounds = await getInbounds();
  for (const inbound of inbounds) {
    const clients = parseInboundSettings(inbound).clients || [];
    const client = clients.find((item) => String(item.id) === value || String(item.subId) === value);
    if (client) return { ...client, inboundId: Number(inbound.id), inbound };
  }
  return null;
}

async function validateInbound(inboundId) {
  const inbounds = await getInbounds();

  const inbound = inbounds.find((item) => Number(item.id) === Number(inboundId));

  if (!inbound) {
    throw new Error(`Inbound ${inboundId} was not found`);
  }

  if (String(inbound.protocol).toLowerCase() !== 'vless') {
    throw new Error(`Inbound ${inboundId} is not a VLESS inbound`);
  }

  if (!inbound.enable) {
    throw new Error(`Inbound ${inboundId} is disabled`);
  }

  return inbound;
}

function buildClient({ existing, email, subId, telegramId, durationDays, trafficGb, limitIp, countryCode }) {
  const expiryTime = Date.now() + Number(durationDays) * 24 * 60 * 60 * 1000;

  const totalGB = Number(trafficGb) * 1024 * 1024 * 1024;

  return {
    id: existing?.id || crypto.randomUUID(),
    email,
    enable: true,
    flow: existing?.flow || '',
    limitIp: Number(limitIp),
    totalGB,
    expiryTime,
    subId: existing?.subId || subId,
    tgId: String(telegramId),
    // This is visible in 3x-ui and keeps client records easy to identify.
    comment: createClientRemark(countryCode, email),
  };
}

async function addClient(inboundId, client) {
  const data = await request('panel/api/clients/add', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client: {
        id: client.id,
        email: client.email,
        subId: client.subId,
        flow: client.flow,
        totalGB: client.totalGB,
        expiryTime: client.expiryTime,
        limitIp: client.limitIp,
        tgId: Number(client.tgId) || 0,
        enable: client.enable,
        comment: client.comment,
      },
      inboundIds: [Number(inboundId)],
    }),
  });

  assertSuccess(data, 'Add client');

  return client;
}

async function updateClient(inboundId, client) {
  const data = await request(`panel/api/clients/update/${encodeURIComponent(client.email)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: client.email,
      totalGB: client.totalGB,
      expiryTime: client.expiryTime,
      limitIp: client.limitIp,
      tgId: Number(client.tgId) || 0,
      enable: client.enable,
      comment: client.comment,
    }),
  });

  assertSuccess(data, 'Update client');

  return client;
}

async function createOrUpdateClient(options) {
  const { email, subId, inboundId, telegramId, durationDays, trafficGb = 0, limitIp = 0, countryCode } = options;

  const existing = await findClient(email);

  // If the client exists, preserve its original inbound.
  const targetInboundId = existing ? Number(existing.inboundId) : Number(inboundId);

  await validateInbound(targetInboundId);

  const client = buildClient({
    existing,
    email,
    subId,
    telegramId,
    durationDays,
    trafficGb,
    limitIp,
    countryCode,
  });

  if (existing) {
    await updateClient(targetInboundId, client);
  } else {
    await addClient(targetInboundId, client);
  }

  return {
    client,
    inboundId: targetInboundId,
    isExisting: Boolean(existing),
  };
}

// These two endpoints are retained from the existing service
// implementation. They must match the API exposed by your panel.

async function getClientLinks(email) {
  const data = await request(`panel/api/clients/links/${encodeURIComponent(email)}`);

  return assertSuccess(data, 'Get client links') || [];
}

async function getSubscriptionLinks(subId) {
  const data = await request(`panel/api/clients/subLinks/${encodeURIComponent(subId)}`);

  return assertSuccess(data, 'Get subscription links') || [];
}

async function provisionClient(options) {
  if (!options.email || !options.inboundId || !options.durationDays) {
    throw new Error('Missing required client provisioning options');
  }

  const subId = options.subId || crypto.randomBytes(12).toString('hex');

  const result = await createOrUpdateClient({
    ...options,
    subId,
  });

  const effectiveSubId = result.client.subId || subId;

  const links = await getClientLinks(options.email);

  let vlessUrl = Array.isArray(links) ? links.find((link) => typeof link === 'string' && link.startsWith('vless://')) : null;

  if (!vlessUrl) {
    const subscriptionLinks = await getSubscriptionLinks(effectiveSubId);

    vlessUrl = Array.isArray(subscriptionLinks) ? subscriptionLinks.find((link) => typeof link === 'string' && link.startsWith('vless://')) : null;
  }

  if (!vlessUrl) {
    throw new Error('Client was saved, but the VLESS link could not be retrieved.');
  }

  const subscriptionUrl = new URL(effectiveSubId, getSubscriptionBaseUrl()).toString();

  return {
    email: options.email,
    uuid: result.client.id,
    subId: effectiveSubId,
    inboundId: result.inboundId,
    vlessUrl: withRemark(vlessUrl, createClientRemark(options.countryCode, options.email)),
    subscriptionUrl,
    expiryTime: result.client.expiryTime,
    updatedExistingClient: result.isExisting,
  };
}

module.exports = {
  request,
  getClient,
  findClient,
  findClientByIdentifier,
  provisionClient,
};
