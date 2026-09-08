import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';

const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `migrations_${randomUUID().replaceAll('-', '')}`;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
process.env.BETTER_AUTH_SECRET = 'migration-synthetic-test-secret-only';
const url = testUrl ? new URL(testUrl) : null;
if (url) {
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
}
const database = await import('../dist/database.js');
const meta = await import('../dist/auth-meta.js');
const auth = await import('../dist/auth.js');
const migrationNames = ['001_storage_runtime.sql', '002_sync_receipts.sql', '003_training_days_cache.sql', '004_training_time_zone.sql', '005_bounded_reads.sql', '006_auth_schema.sql'];

function startProcess() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { ensureDatabaseReady, closeDatabasePool } from './dist/database.js';
      import { ensureAuthDatabaseSchema, closeAuthPool } from './dist/auth-meta.js';
      try { await Promise.all([ensureDatabaseReady(), ensureAuthDatabaseSchema()]); }
      finally { await Promise.all([closeDatabasePool(), closeAuthPool()]); }
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

test('unified migrations serialize processes, preserve legacy auth, rollback/retry and renew auth caches', { skip: !testUrl, timeout: 60000 }, async () => {
  const admin = new Pool({ connectionString: testUrl });
  const scoped = new Pool({ connectionString: url.toString() });
  async function reset() {
    await Promise.all([database.closeDatabasePool(), meta.closeAuthPool()]);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
  }
  try {
    await reset();
    const outputs = await Promise.all([startProcess(), startProcess(), startProcess()]);
    assert.equal(outputs.join('').match(/migration complete/g)?.length, 6);
    assert.deepEqual((await scoped.query('SELECT name FROM app_migrations ORDER BY name')).rows.map(row => row.name), migrationNames);
    assert.equal((await scoped.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename IN ('user','session','account','verification','passkey','user_storage_binding','user_alias')", [schema])).rows[0].n, 7);

    await reset();
    // This is exactly the pre-runner auth baseline, without its later additive column.
    const baseline = await readFile(new URL('./fixtures/legacy-auth-schema.sql', import.meta.url), 'utf8');
    await scoped.query(baseline);
    await scoped.query(`INSERT INTO "user" (id,name,email,username) VALUES ('legacy','Legacy','legacy@example.test','legacy');
      INSERT INTO account (id,account_id,provider_id,user_id) VALUES ('account','123','telegram','legacy');
      INSERT INTO "session" (id,expires_at,token,user_id) VALUES ('session',NOW()+interval '1 day','synthetic-token','legacy');
      INSERT INTO verification (id,identifier,value,expires_at) VALUES ('verification','synthetic','value',NOW());
      INSERT INTO passkey (id,public_key,user_id,credential_id,counter,device_type,backed_up) VALUES ('passkey','synthetic','legacy','credential',3,'singleDevice',false);
      INSERT INTO user_storage_binding (user_id,storage_key) VALUES ('legacy','legacy-storage');
      INSERT INTO user_alias (id,user_id,alias,alias_lower,type) VALUES ('alias','legacy','legacy','legacy','canonical');`);
    const tables = ['user', 'session', 'account', 'verification', 'passkey', 'user_storage_binding', 'user_alias'];
    const before = await Promise.all(tables.map(table => scoped.query(`SELECT row_to_json(t) AS row FROM "${table}" t`)));
    await database.ensureDatabaseReady();
    for (const [i, table] of tables.entries()) {
      const after = (await scoped.query(`SELECT row_to_json(t) AS row FROM "${table}" t`)).rows;
      if (table === 'account') { assert.equal(after[0].row.telegram_username, null); delete after[0].row.telegram_username; }
      assert.deepEqual(after, before[i].rows);
    }
    await assert.rejects(scoped.query("INSERT INTO account (id,account_id,provider_id,user_id) VALUES ('duplicate','123','telegram','legacy')"), { code: '23505' });
    await assert.rejects(scoped.query("INSERT INTO user_storage_binding (user_id,storage_key) VALUES ('missing','other')"), { code: '23503' });
    assert.equal(database.getDatabasePool(), meta.getAuthPool());
    const oldAuth = auth.getAuth();
    const oldHandler = auth.createAuthNodeHandler();
    await Promise.all([database.closeDatabasePool(), meta.closeAuthPool()]);
    await meta.ensureAuthDatabaseSchema();
    assert.notEqual(auth.getAuth(), oldAuth);
    assert.notEqual(auth.createAuthNodeHandler(), oldHandler);
    assert.equal(auth.createAuthNodeHandler(), auth.createAuthNodeHandler());
    const app = express();
    app.all('/api/auth/{*path}', auth.createAuthNodeHandler());
    const response = await request(app).get('/api/auth/get-session').set('Authorization', 'Bearer synthetic-token').expect(200);
    assert.equal(response.body.user.id, 'legacy');

    await reset();
    // Cause SQL inside 006 to fail after its user/session DDL, proving file atomicity.
    await scoped.query('CREATE TABLE account (unrelated TEXT)');
    await assert.rejects(database.ensureDatabaseReady(), { code: '42703' });
    assert.equal((await scoped.query("SELECT to_regclass('\"user\"') AS relation")).rows[0].relation, null);
    assert.equal((await scoped.query("SELECT count(*)::int AS n FROM app_migrations WHERE name = '006_auth_schema.sql'")).rows[0].n, 0);
    const lock = await scoped.connect();
    try {
      const key = (await lock.query("SELECT hashtextextended(current_database() || ':' || current_schema() || ':gym21:migrations', 0)::text AS key")).rows[0].key;
      assert.equal((await lock.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key])).rows[0].acquired, true);
      await lock.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    } finally { lock.release(); }
    await scoped.query('DROP TABLE account');
    await Promise.all([database.ensureDatabaseReady(), meta.ensureAuthDatabaseSchema()]);
    assert.deepEqual((await scoped.query('SELECT name FROM app_migrations ORDER BY name')).rows.map(row => row.name), migrationNames);
  } finally {
    await auth.closeAuthResources();
    await database.closeDatabasePool();
    await scoped.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
