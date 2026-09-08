import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient, type Client } from 'pg';
import { databaseConnectionOptions } from './database-tls.js';
import { config } from './config.js';

interface AppliedMigrationRow {
  name: string;
}

let pool: Pool | null = null;
let migrationsReady = false;
let closingPromise: Promise<void> | null = null;
const poolClients = new WeakMap<Pool, { clients: Set<PoolClient>; forced: boolean }>();
let migrationsPromise: Promise<void> | null = null;

function assertDatabaseUrl() {
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
}

export function getDatabasePool(): Pool {
  if (closingPromise) throw new Error('Database is shutting down');
  if (!pool) {
    assertDatabaseUrl();
    pool = new Pool({
      connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
      statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
      query_timeout: config.DB_QUERY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: config.DB_STATEMENT_TIMEOUT_MS,
      ...databaseConnectionOptions(config),
    });
    const state = { clients: new Set<PoolClient>(), forced: false };
    poolClients.set(pool, state);
    pool.on('connect', client => {
      state.clients.add(client);
      client.once('end', () => state.clients.delete(client));
      client.on('error', () => console.warn('[database] connection lost'));
      if (state.forced) void (client as unknown as Client).end().catch(() => {});
    });
    pool.on('error', () => console.error('[database] idle connection lost'));
  }

  return pool;
}

async function readMigrationFiles(): Promise<Array<{ name: string; sql: string }>> {
  const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await fs.readFile(path.join(migrationsDir, name), 'utf8'),
    })),
  );
}

/** A session lock covers registry creation, discovery and every migration transaction. */
async function migrate(currentPool: Pool): Promise<void> {
  const migrations = await readMigrationFiles();
  const client = await currentPool.connect();
  // Migrations may scan large existing tables; their bounded budget is separate.
  const query = (text: string, values?: unknown[]) => client.query(Object.assign({ text, values }, { query_timeout: config.DB_MIGRATION_TIMEOUT_MS + 1_000 }));
  let locked = false;
  let destroy = false;
  let lockKey: string | undefined;
  try {
    // Database/schema scope lets isolated schemas migrate independently. Keep the key
    // on this connection so migration SQL cannot change the unlock target.
    await query("SELECT set_config('statement_timeout', $1, false)", [String(config.DB_MIGRATION_TIMEOUT_MS)]);
    const key = await client.query<{ key: string }>(
      "SELECT hashtextextended(current_database() || ':' || current_schema() || ':gym21:migrations', 0)::text AS key",
    );
    lockKey = key.rows[0]!.key;
    await query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await client.query<AppliedMigrationRow>('SELECT name FROM app_migrations');
    const appliedNames = new Set(applied.rows.map(row => row.name));
    for (const migration of migrations) {
      if (appliedNames.has(migration.name)) continue;
      console.info('[database] migration start', { migration: migration.name });
      try {
        await client.query('BEGIN');
        await query(migration.sql);
        await client.query('INSERT INTO app_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        console.info('[database] migration complete', { migration: migration.name });
      } catch (error) {
        console.error('[database] migration failed', { migration: migration.name });
        try { await client.query('ROLLBACK'); } catch { destroy = true; }
        throw error;
      }
    }
  } finally {
    if (locked && !destroy) {
      try {
        const result = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [lockKey]);
        destroy = result.rows[0]?.unlocked !== true;
      } catch { destroy = true; }
      if (destroy) console.error('[database] migration lock release failed; discarding connection');
    }
    if (!destroy && locked) {
      try { await client.query("SELECT set_config('statement_timeout', $1, false)", [String(config.DB_STATEMENT_TIMEOUT_MS)]); } catch { destroy = true; }
    }
    // Destroy also covers an uncertain lock acquisition (e.g. a disconnected session).
    client.release(destroy || !locked);
  }
}

export function ensureDatabaseReady(): Promise<void> {
  if (!migrationsPromise) {
    const currentPool = getDatabasePool();
    const attempt = migrate(currentPool).then(() => {
      if (pool === currentPool && migrationsPromise === attempt) migrationsReady = true;
    }).catch(error => {
      if (pool === currentPool && migrationsPromise === attempt) { migrationsReady = false; migrationsPromise = null; }
      throw error;
    });
    migrationsPromise = attempt;
  }
  return migrationsPromise;
}

/** Short probe uses a dedicated checkout and destroys it on timeout, including late checkout. */
export async function checkDatabaseReadiness(): Promise<boolean> {
  if (!migrationsReady || !pool || closingPromise) return false;
  const currentPool = pool;
  let client: PoolClient | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = (async () => {
      const acquired = await currentPool.connect();
      if (expired) { acquired.release(true); return false; }
      client = acquired;
      await acquired.query(Object.assign({ text: 'SELECT 1' }, { query_timeout: config.READINESS_TIMEOUT_MS }));
      return migrationsReady && pool === currentPool && !closingPromise;
    })();
    return await Promise.race([probe, new Promise<boolean>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(false); }, config.READINESS_TIMEOUT_MS);
    })]);
  } catch { expired = true; return false; }
  finally {
    clearTimeout(timer);
    if (client) client.release(expired);
  }
}

export function closeDatabasePool(timeoutMs = config.SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (closingPromise) return closingPromise;
  if (!pool) return Promise.resolve();
  const currentPool = pool;
  pool = null;
  migrationsReady = false;
  migrationsPromise = null;
  const state = poolClients.get(currentPool)!;
  closingPromise = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = currentPool.end();
    try {
      await Promise.race([ended, new Promise<void>(resolve => {
        timer = setTimeout(() => {
          console.warn('[database] shutdown deadline; closing active connections', { connections: state.clients.size });
          state.forced = true;
          for (const client of state.clients) void (client as unknown as Client).end().catch(() => {});
          resolve();
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); closingPromise = null; }
  })();
  return closingPromise;
}
