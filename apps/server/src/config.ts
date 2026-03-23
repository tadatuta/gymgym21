import process from 'node:process';

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) return false;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && asNumber >= 0) {
    return asNumber;
  }

  return value;
}

const defaultAppOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
const authBaseURL = process.env.AUTH_BASE_URL || 'http://localhost:8788/api/auth';
const authOrigin = new URL(authBaseURL).origin;
const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS, [defaultAppOrigin]);

if (!process.env.ALLOWED_ORIGIN && !process.env.ALLOWED_ORIGINS) {
  console.warn('WARNING: ALLOWED_ORIGIN/ALLOWED_ORIGINS not set, CORS will be restrictive');
}

export const config = {
  STORAGE_DIR: process.env.STORAGE_DIR || '/tmp/bucket-storage',
  ALLOWED_ORIGIN: defaultAppOrigin,
  ALLOWED_ORIGINS: allowedOrigins,
  APP_BASE_URL: process.env.APP_BASE_URL || defaultAppOrigin,
  AUTH_BASE_URL: authBaseURL,
  AUTH_ORIGIN: authOrigin,
  PORT: parsePort(process.env.PORT, 8788),
  HOST: process.env.HOST || '0.0.0.0',
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
  JSON_BODY_LIMIT: process.env.JSON_BODY_LIMIT || '10mb',
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || '',
  DATABASE_URL: process.env.DATABASE_URL || '',
  DATABASE_SSL: process.env.DATABASE_SSL === 'true',
  PASSKEY_RP_ID: process.env.PASSKEY_RP_ID || 'localhost',
  PASSKEY_RP_NAME: process.env.PASSKEY_RP_NAME || 'Gym Gym 21',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN: process.env.TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN || 'telegram.local.invalid',
};

export const HAS_DATABASE = Boolean(config.DATABASE_URL);
