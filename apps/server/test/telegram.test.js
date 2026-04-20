import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { test } from 'node:test';

process.env.TELEGRAM_BOT_TOKEN = 'test_token';

const {
  detectTelegramInitDataType,
  extractTelegramUser,
  parseTelegramInitData,
  validateTelegramInitData,
  validateTelegramLoginWidgetData,
  validateTelegramWebAppData,
} = await import('../dist/telegram.js');

function createDataCheckString(data) {
  return Object.entries(data)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function signLoginWidgetData(data) {
  const secretKey = createHash('sha256').update('test_token').digest();
  return createHmac('sha256', secretKey)
    .update(createDataCheckString(data))
    .digest('hex');
}

function signWebAppData(data) {
  const secretKey = createHmac('sha256', 'WebAppData').update('test_token').digest();
  return createHmac('sha256', secretKey)
    .update(createDataCheckString(data))
    .digest('hex');
}

function encodeInitData(data, sign) {
  const hash = sign(data);
  return `${new URLSearchParams(data).toString()}&hash=${hash}`;
}

function createLoginWidgetInitData(overrides = {}) {
  const data = {
    id: '777',
    first_name: 'Legacy',
    username: 'legacy_user',
    auth_date: Math.floor(Date.now() / 1000).toString(),
    ...overrides,
  };

  return encodeInitData(data, signLoginWidgetData);
}

function createWebAppInitData(overrides = {}) {
  const user = {
    id: 888,
    first_name: 'Mini',
    username: 'mini_user',
    language_code: 'ru',
    is_premium: true,
    allows_write_to_pm: true,
    photo_url: 'https://example.com/mini-user.png',
  };

  const data = {
    user: JSON.stringify(user),
    auth_date: Math.floor(Date.now() / 1000).toString(),
    query_id: 'AAEAAAE',
    ...overrides,
  };

  return encodeInitData(data, signWebAppData);
}

test('validates Telegram Login Widget payloads and extracts a flat user', () => {
  const initData = createLoginWidgetInitData();
  const parsed = parseTelegramInitData(initData);

  assert.equal(detectTelegramInitDataType(initData), 'login-widget');
  assert.equal(validateTelegramLoginWidgetData(initData), true);
  assert.equal(validateTelegramInitData(initData), true);
  assert.equal(parsed.type, 'login-widget');
  assert.deepEqual(parsed.user, {
    id: 777,
    first_name: 'Legacy',
    username: 'legacy_user',
    last_name: undefined,
    photo_url: undefined,
  });
});

test('validates Telegram Mini App payloads and extracts the nested user JSON', () => {
  const initData = createWebAppInitData();
  const parsed = parseTelegramInitData(initData);

  assert.equal(detectTelegramInitDataType(initData), 'web-app');
  assert.equal(validateTelegramWebAppData(initData), true);
  assert.equal(validateTelegramInitData(initData), true);
  assert.equal(parsed.type, 'web-app');
  assert.deepEqual(parsed.user, {
    id: 888,
    first_name: 'Mini',
    username: 'mini_user',
    language_code: 'ru',
    is_premium: true,
    allows_write_to_pm: true,
    photo_url: 'https://example.com/mini-user.png',
    last_name: undefined,
  });
});

test('rejects payloads with an invalid Telegram hash', () => {
  const initData = `${createWebAppInitData()}0`;

  assert.equal(validateTelegramWebAppData(initData), false);
  assert.equal(validateTelegramInitData(initData), false);
});

test('rejects expired auth_date values', () => {
  const initData = createLoginWidgetInitData({
    auth_date: String(Math.floor(Date.now() / 1000) - 86401),
  });

  assert.equal(validateTelegramLoginWidgetData(initData), false);
  assert.equal(validateTelegramInitData(initData), false);
});

test('returns no user for malformed Mini App user JSON even if the signature is valid', () => {
  const initData = createWebAppInitData({
    user: '{"id":888,"first_name":"Mini"',
  });

  assert.equal(validateTelegramWebAppData(initData), true);
  assert.equal(parseTelegramInitData(initData).type, 'web-app');
  assert.equal(extractTelegramUser(initData), undefined);
});

test('rejects signed payloads that do not match a supported Telegram auth shape', () => {
  const data = {
    auth_date: Math.floor(Date.now() / 1000).toString(),
    query_id: 'AAEAAAE',
  };
  const initData = encodeInitData(data, signWebAppData);

  assert.equal(detectTelegramInitDataType(initData), 'unsupported');
  assert.deepEqual(parseTelegramInitData(initData), {
    type: 'unsupported',
    user: undefined,
  });
  assert.equal(validateTelegramInitData(initData), false);
});
