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

export async function ensureDatabaseReady() {
  if (!migrationsPromise) {
    migrationsPromise = (async () => {
      const currentPool = getDatabasePool();

      await currentPool.query(`
        CREATE TABLE IF NOT EXISTS app_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const applied = await currentPool.query<AppliedMigrationRow>('SELECT name FROM app_migrations');
      const appliedNames = new Set(applied.rows.map((row) => row.name));
      const migrations = await readMigrationFiles();

      for (const migration of migrations) {
        if (appliedNames.has(migration.name)) {
          continue;
        }

        const client = await currentPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query('INSERT INTO app_migrations (name) VALUES ($1)', [migration.name]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    })();
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
