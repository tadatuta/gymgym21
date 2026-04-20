import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
}

export type TelegramInitDataType = 'login-widget' | 'web-app' | 'unsupported';

const TELEGRAM_AUTH_MAX_AGE_SECONDS = 86400;
const TELEGRAM_AUTH_MAX_FUTURE_SKEW_SECONDS = 300;

// Supported Telegram auth inputs:
// - Login Widget callback/redirect payloads with flat fields like id, first_name, auth_date, hash
// - Mini App initData payloads with JSON-serialized user=... plus auth_date and hash

function getSearchParams(initData: string): URLSearchParams {
  return new URLSearchParams(initData);
}

function parseNumericId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return undefined;
}

function extractLoginWidgetUser(urlParams: URLSearchParams): TelegramUser | undefined {
  const id = parseNumericId(urlParams.get('id'));
  if (!id) {
    return undefined;
  }

  return {
    id,
    first_name: urlParams.get('first_name') || '',
    last_name: urlParams.get('last_name') || undefined,
    username: urlParams.get('username') || undefined,
    photo_url: urlParams.get('photo_url') || undefined,
  };
}

function extractWebAppUser(urlParams: URLSearchParams): TelegramUser | undefined {
  const rawUser = urlParams.get('user');
  if (!rawUser) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawUser) as Record<string, unknown>;
    const id = parseNumericId(parsed.id);
    if (!id) {
      return undefined;
    }

    return {
      id,
      first_name: typeof parsed.first_name === 'string' ? parsed.first_name : '',
      last_name: parseOptionalString(parsed.last_name),
      username: parseOptionalString(parsed.username),
      photo_url: parseOptionalString(parsed.photo_url),
      language_code: parseOptionalString(parsed.language_code),
      is_premium: parseOptionalBoolean(parsed.is_premium),
      allows_write_to_pm: parseOptionalBoolean(parsed.allows_write_to_pm),
    };
  } catch {
    return undefined;
  }
}

function hasValidAuthDate(urlParams: URLSearchParams): boolean {
  const authDate = urlParams.get('auth_date');
  if (!authDate) {
    return false;
  }

  const authTimestamp = Number.parseInt(authDate, 10);
  const nowTimestamp = Math.floor(Date.now() / 1000);

  if (Number.isNaN(authTimestamp)) {
    return false;
  }

  if ((nowTimestamp - authTimestamp) > TELEGRAM_AUTH_MAX_AGE_SECONDS) {
    return false;
  }

  if ((authTimestamp - nowTimestamp) > TELEGRAM_AUTH_MAX_FUTURE_SKEW_SECONDS) {
    return false;
  }

  return true;
}

function buildDataCheckString(urlParams: URLSearchParams): string {
  const entries = Array.from(urlParams.entries())
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.map(([key, value]) => `${key}=${value}`).join('\n');
}

function isSupportedHash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function hashesMatch(expectedHash: string, receivedHash: string): boolean {
  if (!isSupportedHash(expectedHash) || !isSupportedHash(receivedHash)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(receivedHash, 'hex'));
}

function validateTelegramSignature(
  urlParams: URLSearchParams,
  secretKeyFactory: () => Buffer,
): boolean {
  const hash = urlParams.get('hash');
  if (!hash || !hasValidAuthDate(urlParams)) {
    return false;
  }

  const dataCheckString = buildDataCheckString(urlParams);
  const calculatedHash = createHmac('sha256', secretKeyFactory())
    .update(dataCheckString)
    .digest('hex');

  return hashesMatch(calculatedHash, hash);
}

export function detectTelegramInitDataType(initData: string): TelegramInitDataType {
  const urlParams = getSearchParams(initData);

  if (urlParams.has('user')) {
    return 'web-app';
  }

  if (urlParams.has('id')) {
    return 'login-widget';
  }

  return 'unsupported';
}

export function extractTelegramUser(initData: string): TelegramUser | undefined {
  const urlParams = getSearchParams(initData);

  switch (detectTelegramInitDataType(initData)) {
    case 'login-widget':
      return extractLoginWidgetUser(urlParams);
    case 'web-app':
      return extractWebAppUser(urlParams);
    default:
      return undefined;
  }
}

export function parseTelegramInitData(initData: string): { type: TelegramInitDataType; user?: TelegramUser } {
  return {
    type: detectTelegramInitDataType(initData),
    user: extractTelegramUser(initData),
  };
}

export function validateTelegramLoginWidgetData(initData: string): boolean {
  if (!config.TELEGRAM_BOT_TOKEN) {
    return false;
  }

  const urlParams = getSearchParams(initData);
  if (!extractLoginWidgetUser(urlParams)) {
    return false;
  }

  return validateTelegramSignature(urlParams, () => createHash('sha256').update(config.TELEGRAM_BOT_TOKEN).digest());
}

export function validateTelegramWebAppData(initData: string): boolean {
  if (!config.TELEGRAM_BOT_TOKEN) {
    return false;
  }

  const urlParams = getSearchParams(initData);
  if (detectTelegramInitDataType(initData) !== 'web-app') {
    return false;
  }

  // Mini App initData uses HMAC(bot_token, "WebAppData") as the secret for hash verification.
  return validateTelegramSignature(urlParams, () => createHmac('sha256', 'WebAppData').update(config.TELEGRAM_BOT_TOKEN).digest());
}

export function validateTelegramInitData(initData: string): boolean {
  switch (detectTelegramInitDataType(initData)) {
    case 'login-widget':
      return validateTelegramLoginWidgetData(initData);
    case 'web-app':
      return validateTelegramWebAppData(initData);
    default:
      return false;
  }
}
