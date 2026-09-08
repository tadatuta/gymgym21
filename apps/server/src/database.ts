import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { config } from './config.js';

interface AppliedMigrationRow {
  name: string;
}

let pool: Pool | null = null;
let migrationsPromise: Promise<void> | null = null;

function assertDatabaseUrl() {
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
}

export function getDatabasePool(): Pool {
  if (!pool) {
    assertDatabaseUrl();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    });
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
  let locked = false;
  let destroy = false;
  let lockKey: string | undefined;
  try {
    // Database/schema scope lets isolated schemas migrate independently. Keep the key
    // on this connection so migration SQL cannot change the unlock target.
    const key = await client.query<{ key: string }>(
      "SELECT hashtextextended(current_database() || ':' || current_schema() || ':gym21:migrations', 0)::text AS key",
    );
    lockKey = key.rows[0]!.key;
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
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
        await client.query(migration.sql);
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
    // Destroy also covers an uncertain lock acquisition (e.g. a disconnected session).
    client.release(destroy || !locked);
  }
}

export function ensureDatabaseReady(): Promise<void> {
  if (!migrationsPromise) {
    const attempt = migrate(getDatabasePool()).catch(error => {
      if (migrationsPromise === attempt) migrationsPromise = null;
      throw error;
    });
    migrationsPromise = attempt;
  }
  return migrationsPromise;
}

export async function closeDatabasePool() {
  if (!pool) {
    return;
  }

  const currentPool = pool;
  pool = null;
  migrationsPromise = null;
  await currentPool.end();
}
