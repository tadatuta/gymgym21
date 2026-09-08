import { createHash, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { config } from '../../config.js';
import { getDatabasePool } from '../../database.js';

export interface LimitRequest { key: string; windowMs: number; maxRequests: number; maxConcurrent?: number }
export interface LimitResult { kind: 'allowed' | 'window' | 'concurrency'; count: number; resetAt: number; lease?: string }
export interface RateLimitStore {
  acquire(request: LimitRequest): Promise<LimitResult>;
  renew(lease: string): Promise<boolean>;
  release(lease: string): Promise<void>;
}

/** Explicit fixture store. Runtime never falls back to process-local counters. */
export function createMemoryRateLimitStore(): RateLimitStore {
  const entries = new Map<string, { count: number; resetAt: number; leases: Set<string> }>();
  const leases = new Map<string, string>();
  return {
    async acquire(request) {
      const now = Date.now();
      for (const [key, entry] of entries) if (entry.resetAt <= now && !entry.leases.size) entries.delete(key);
      let entry = entries.get(request.key);
      if (!entry) { entry = { count: 0, resetAt: now + request.windowMs, leases: new Set() }; entries.set(request.key, entry); }
      if (entry.resetAt <= now) { entry.count = 0; entry.resetAt = now + request.windowMs; }
      const result = { count: entry.count, resetAt: entry.resetAt };
      if (request.maxConcurrent && entry.leases.size >= request.maxConcurrent) return { ...result, kind: 'concurrency' };
      if (entry.count >= request.maxRequests) return { ...result, kind: 'window' };
      const lease = request.maxConcurrent ? randomUUID() : undefined;
      entry.count++;
      if (lease) { entry.leases.add(lease); leases.set(lease, request.key); }
      return { kind: 'allowed', count: entry.count, resetAt: entry.resetAt, lease };
    },
    async renew(lease) { return leases.has(lease); },
    async release(lease) { const key = leases.get(lease); if (key) entries.get(key)?.leases.delete(lease); leases.delete(lease); },
  };
}

export class PostgresRateLimitStore implements RateLimitStore {
  private readonly leasePools = new Map<string, Pool>();
  constructor(private readonly pool: () => Pool = getDatabasePool) {}

  async acquire(request: LimitRequest): Promise<LimitResult> {
    const currentPool = this.pool();
    const client = await currentPool.connect();
    let destroy = false;
    const query = <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) =>
      client.query<T>(Object.assign({ text, values }, { query_timeout: config.RATE_LIMIT_STORE_TIMEOUT_MS }));
    // Persist only a one-way digest, never IP addresses/storage identities.
    const key = createHash('sha256').update(request.key).digest('hex');
    try {
      await query('BEGIN');
      await query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(config.RATE_LIMIT_STORE_TIMEOUT_MS)]);
      // The upsert itself owns the row lock. DO NOTHING + a later SELECT would
      // leave a gap in which cleanup could delete an expired bucket.
      const row = (await query<{ request_count: number; reset_at: Date; now: Date }>(`
        INSERT INTO rate_limit_buckets (key, reset_at, request_count)
        VALUES ($1, clock_timestamp() + $2 * interval '1 millisecond', 0)
        ON CONFLICT (key) DO UPDATE SET key=EXCLUDED.key
        RETURNING request_count, reset_at, clock_timestamp() AS now`, [key, request.windowMs])).rows[0]!;
      const now = row.now.getTime();
      const expired = row.reset_at.getTime() <= now;
      let count = expired ? 0 : row.request_count;
      const resetAt = expired ? now + request.windowMs : row.reset_at.getTime();
      if (request.maxConcurrent) await query('DELETE FROM rate_limit_leases WHERE bucket_key=$1 AND expires_at <= clock_timestamp()', [key]);
      const active = request.maxConcurrent ? (await query<{ n: number }>('SELECT count(*)::int AS n FROM rate_limit_leases WHERE bucket_key=$1', [key])).rows[0]!.n : 0;
      const kind = request.maxConcurrent && active >= request.maxConcurrent ? 'concurrency' : count >= request.maxRequests ? 'window' : 'allowed';
      const lease = kind === 'allowed' && request.maxConcurrent ? randomUUID() : undefined;
      if (kind === 'allowed') count++;
      if (lease) {
        await query(`INSERT INTO rate_limit_leases (id,bucket_key,expires_at) VALUES ($1,$2,clock_timestamp() + $3 * interval '1 millisecond')`, [lease, key, config.RATE_LIMIT_LEASE_MS]);
      }
      await query('UPDATE rate_limit_buckets SET request_count=$2, reset_at=$3 WHERE key=$1', [key, count, new Date(resetAt)]);
      await query('COMMIT');
      if (lease) this.leasePools.set(lease, currentPool);
      return { kind, count, resetAt, lease };
    } catch (error) {
      try { await query('ROLLBACK'); } catch { destroy = true; }
      throw error;
    } finally { client.release(destroy); }
  }

  private async query(text: string, values?: unknown[], currentPool: Pool = this.pool()) {
    const client = await currentPool.connect();
    const query = (sql: string, parameters?: unknown[]) =>
      client.query(Object.assign({ text: sql, values: parameters }, { query_timeout: config.RATE_LIMIT_STORE_TIMEOUT_MS }));
    let destroy = false;
    try {
      await query('BEGIN');
      await query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(config.RATE_LIMIT_STORE_TIMEOUT_MS)]);
      const result = await query(text, values);
      await query('COMMIT');
      return result;
    } catch (error) {
      try { await query('ROLLBACK'); } catch { destroy = true; }
      throw error;
    } finally { client.release(destroy); }
  }

  async renew(lease: string): Promise<boolean> {
    const owner = this.leasePools.get(lease);
    if (!owner) return false;
    const result = await this.query(`UPDATE rate_limit_leases SET expires_at=clock_timestamp() + $2 * interval '1 millisecond'
      WHERE id=$1 AND expires_at > clock_timestamp()`, [lease, config.RATE_LIMIT_LEASE_MS], owner);
    return result.rowCount === 1;
  }

  async release(lease: string): Promise<void> {
    const owner = this.leasePools.get(lease);
    if (!owner) return;
    try { await this.query('DELETE FROM rate_limit_leases WHERE id=$1', [lease], owner); }
    finally { this.leasePools.delete(lease); }
  }

  /** Bounded batches; SKIP LOCKED avoids blocking live admission transactions. */
  async cleanup(): Promise<void> {
    await this.query(`DELETE FROM rate_limit_leases WHERE id IN
      (SELECT id FROM rate_limit_leases WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)`);
    await this.query(`DELETE FROM rate_limit_buckets WHERE key IN
      (SELECT key FROM rate_limit_buckets b WHERE reset_at <= clock_timestamp()
       AND NOT EXISTS (SELECT 1 FROM rate_limit_leases l WHERE l.bucket_key=b.key)
       ORDER BY reset_at LIMIT 500 FOR UPDATE SKIP LOCKED)`);
  }
}

export const defaultRateLimitStore = new PostgresRateLimitStore();
