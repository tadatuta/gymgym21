import type { RequestHandler } from 'express';
import { config } from '../../config.js';

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

const allowedOrigins = new Set(
  [config.APP_BASE_URL, config.AUTH_ORIGIN, ...config.ALLOWED_ORIGINS]
    .filter(Boolean)
    .map(normalizeOrigin),
);

function getCorsOrigin(requestOrigin: string | undefined): string | null {
  if (!requestOrigin) {
    return normalizeOrigin(config.ALLOWED_ORIGIN);
  }

  const normalizedOrigin = normalizeOrigin(requestOrigin);
  return allowedOrigins.has(normalizedOrigin) ? normalizedOrigin : null;
}

export const corsMiddleware: RequestHandler = (req, res, next) => {
  const origin = getCorsOrigin(req.header('origin') ?? undefined);

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, X-Telegram-Init-Data');
  res.setHeader('Access-Control-Expose-Headers', 'set-auth-token');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  if (req.method === 'OPTIONS') {
    if (!origin && req.header('origin')) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }

    res.status(204).end();
    return;
  }

  next();
};
