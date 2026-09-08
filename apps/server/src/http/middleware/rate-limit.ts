import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { config } from '../../config.js';
import { defaultRateLimitStore, type LimitResult, type RateLimitStore } from './rate-limit-store.js';

// Response completion and the actual operation are separate lifetimes.
const operationHolds = new WeakMap<Response, Set<Promise<unknown>>>();
export function holdRateLimitUntil(res: Response, operation: Promise<unknown>): void {
  let holds = operationHolds.get(res);
  if (!holds) { holds = new Set(); operationHolds.set(res, holds); }
  holds.add(operation);
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

function logRateLimitEvent(kind: 'window' | 'concurrency' | 'store' | 'lease', policy: RateLimitPolicy, req: Request, key: string, details: Record<string, unknown>) {
  console.warn('[rate-limit]', {
    kind,
    policy: policy.name,
    method: req.method,
    client: anonymizeKey(key),
    ...details,
  });
}

function setRateLimitHeaders(res: Response, policy: RateLimitPolicy, result: LimitResult) {
  res.setHeader('X-RateLimit-Limit', String(policy.maxRequests));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(policy.maxRequests - result.count, 0)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
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

// Any uncertain lease blocks new admissions through this store on this process.
// An expired lease cannot be resurrected: fail closed until its operation settles.
const uncertainLeases = new WeakMap<RateLimitStore, Set<string>>();
export function rateLimitStoreReady(store: RateLimitStore = defaultRateLimitStore): boolean {
  return !uncertainLeases.get(store)?.size;
}

export function createRateLimitMiddleware(policy: RateLimitPolicy, store: RateLimitStore = defaultRateLimitStore): RequestHandler {
  if (!config.RATE_LIMITS_ENABLED) return (_req, _res, next) => next();
  let uncertain = uncertainLeases.get(store);
  if (!uncertain) { uncertain = new Set(); uncertainLeases.set(store, uncertain); }
  const blocked = uncertain;

  return async (req, res, next) => {
    const key = `${policy.name}:${policy.keyGenerator(req)}`;
    let result: LimitResult;
    try {
      if (blocked.size) throw new Error('Lease ownership uncertain');
      result = await store.acquire({ key, windowMs: policy.windowMs, maxRequests: policy.maxRequests, maxConcurrent: policy.maxConcurrent });
    } catch {
      logRateLimitEvent('store', policy, req, key, {});
      if (!res.destroyed) res.set('Retry-After', '1').status(503).json({ error: 'Rate limit store unavailable', code: 'RATE_LIMIT_UNAVAILABLE' });
      return;
    }
    if (!res.destroyed) setRateLimitHeaders(res, policy, result);
    if (result.kind !== 'allowed') {
      logRateLimitEvent(result.kind, policy, req, key, {});
      const retryAfterSeconds = result.kind === 'window' ? Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)) : 1;
      if (!res.destroyed) res.set('Retry-After', String(retryAfterSeconds)).status(result.kind === 'window' ? 429 : 503).json({
        error: result.kind === 'window' ? 'Too many requests' : 'Route is temporarily busy',
        code: result.kind === 'window' ? 'RATE_LIMIT_EXCEEDED' : 'ROUTE_BUSY',
        details: { policy: policy.name, retryAfterSeconds },
      });
      return;
    }
    if (!result.lease) { if (!res.destroyed && !req.aborted) next(); return; }
    const lease = result.lease;
    let released = false;
    let lost = false;
    let renewing: Promise<void> | undefined;
    const renew = async () => {
      if (released || renewing || lost) return;
      renewing = (async () => {
        try {
          if (!await store.renew(lease)) { lost = true; throw new Error('Lease expired'); }
          blocked.delete(lease);
        } catch {
          const wasUncertain = blocked.has(lease);
          blocked.add(lease);
          if (!wasUncertain || lost) logRateLimitEvent('lease', policy, req, key, { lost });
          // Triggers the AI disconnect abort; ignored aborts remain held locally.
          res.destroy();
        }
      })();
      await renewing;
      renewing = undefined;
    };
    const timer = setInterval(() => { void renew(); }, Math.max(10, Math.floor(config.RATE_LIMIT_LEASE_MS / 4)));
    timer.unref();
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await renewing;
      try { await store.release(lease); }
      catch { logRateLimitEvent('store', policy, req, key, { action: 'release' }); }
      finally { blocked.delete(lease); }
    };
    let responseEnded = false;
    const onEnd = () => {
      if (responseEnded) return;
      responseEnded = true;
      res.removeListener('finish', onEnd);
      res.removeListener('close', onEnd);
      const holds = operationHolds.get(res);
      if (holds?.size) void Promise.allSettled([...holds]).then(release);
      else void release();
    };
    res.on('finish', onEnd);
    res.on('close', onEnd);
    if (res.destroyed || req.aborted) { onEnd(); return; }
    next();
  };
}
