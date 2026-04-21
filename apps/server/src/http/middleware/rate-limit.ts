import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../../config.js';

interface RateLimitEntry {
  windowStartedAt: number;
  requestCount: number;
  inFlight: number;
}

export interface RateLimitPolicy {
  name: string;
  windowMs: number;
  maxRequests: number;
  maxConcurrent?: number;
  keyGenerator: (req: Request) => string;
}

function getRequestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function anonymizeKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function logRateLimitEvent(kind: 'window' | 'concurrency', policy: RateLimitPolicy, req: Request, key: string, details: Record<string, unknown>) {
  console.warn('[rate-limit]', {
    kind,
    policy: policy.name,
    method: req.method,
    path: req.path,
    client: anonymizeKey(key),
    ...details,
  });
}

function setRateLimitHeaders(res: Response, policy: RateLimitPolicy, entry: RateLimitEntry) {
  const resetAt = entry.windowStartedAt + policy.windowMs;
  const remaining = Math.max(policy.maxRequests - entry.requestCount, 0);

  res.setHeader('X-RateLimit-Limit', String(policy.maxRequests));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}

export function createIpRateLimitKey(scope: string) {
  return (req: Request) => `${scope}:ip:${getRequestIp(req)}`;
}

export function createStorageRateLimitKey(scope: string) {
  return (req: Request) => {
    const storageKey = req.authContext?.storageKey;
    if (storageKey !== undefined && storageKey !== null) {
      return `${scope}:storage:${String(storageKey)}`;
    }

    return `${scope}:ip:${getRequestIp(req)}`;
  };
}

export function createRateLimitMiddleware(policy: RateLimitPolicy): RequestHandler {
  if (!config.RATE_LIMITS_ENABLED) {
    return (_req, _res, next) => next();
  }

  const entries = new Map<string, RateLimitEntry>();
  let requestsSinceCleanup = 0;

  function cleanup(now: number) {
    for (const [key, entry] of entries) {
      const expired = now - entry.windowStartedAt >= policy.windowMs;
      if (expired && entry.inFlight === 0) {
        entries.delete(key);
      }
    }
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const key = policy.keyGenerator(req);
    const now = Date.now();

    if ((requestsSinceCleanup += 1) % 200 === 0) {
      cleanup(now);
    }

    let entry = entries.get(key);
    if (!entry) {
      entry = {
        windowStartedAt: now,
        requestCount: 0,
        inFlight: 0,
      };
      entries.set(key, entry);
    } else if (now - entry.windowStartedAt >= policy.windowMs) {
      entry.windowStartedAt = now;
      entry.requestCount = 0;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStartedAt + policy.windowMs - now) / 1000));

    if (policy.maxConcurrent && entry.inFlight >= policy.maxConcurrent) {
      logRateLimitEvent('concurrency', policy, req, key, {
        inFlight: entry.inFlight,
        maxConcurrent: policy.maxConcurrent,
      });
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        error: 'Route is temporarily busy',
        code: 'ROUTE_BUSY',
        details: {
          policy: policy.name,
        },
      });
      return;
    }

    if (entry.requestCount >= policy.maxRequests) {
      logRateLimitEvent('window', policy, req, key, {
        limit: policy.maxRequests,
        windowMs: policy.windowMs,
      });
      setRateLimitHeaders(res, policy, entry);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMIT_EXCEEDED',
        details: {
          policy: policy.name,
          retryAfterSeconds,
        },
      });
      return;
    }

    entry.requestCount += 1;
    entry.inFlight += 1;
    setRateLimitHeaders(res, policy, entry);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;

      const currentEntry = entries.get(key);
      if (!currentEntry) return;

      currentEntry.inFlight = Math.max(0, currentEntry.inFlight - 1);

      const expired = Date.now() - currentEntry.windowStartedAt >= policy.windowMs;
      if (expired && currentEntry.inFlight === 0) {
        entries.delete(key);
      }
    };

    res.on('finish', release);
    res.on('close', release);

    next();
  };
}
