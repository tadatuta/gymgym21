import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
process.env.BETTER_AUTH_SECRET = 'ai-context-synthetic-test-secret';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `ai_context_${randomUUID().replaceAll('-', '')}`;
let admin;
if (testUrl) {
  admin = new Pool({ connectionString: testUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(testUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
}
const { defaultStorageRepository: repository } = await import('../dist/storage.js');
const { getDatabasePool, closeDatabasePool } = await import('../dist/database.js');
const { closeAuthResources } = await import('../dist/auth.js');

test('PostgreSQL AI reads one revision snapshot and rejects a stale expected revision', { skip: !testUrl }, async () => {
  try {
    const data = name => ({ logs: [], workouts: [], workoutTypes: [{ id: 'T', name }], profile: { id: 'me', displayName: name, createdAt: '2026-09-01T00:00:00Z' } });
    await repository.replaceSnapshot('ai', data('Before'));
    const pool = getDatabasePool();
    const revision = Number((await pool.query("SELECT server_revision FROM storage_roots WHERE storage_key = 'ai'")).rows[0].server_revision);
    assert.equal((await repository.readAiContext('ai', revision)).profile.displayName, 'Before');
    const connect = pool.connect.bind(pool);
    // Interleave a committed writer after the reader establishes its snapshot.
    let injected = false;
    pool.connect = async () => {
      const client = await connect();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      client.query = async (...args) => {
        const result = await query(...args);
        if (!injected && String(args[0]).startsWith('SELECT server_revision FROM storage_roots')) {
          injected = true;
          await repository.replaceSnapshot('ai', data('After'));
        }
        return result;
      };
      client.release = (...args) => { client.query = query; client.release = release; release(...args); };
      return client;
    };
    let snapshot;
    try { snapshot = await repository.readAiContext('ai', revision); }
    finally { pool.connect = connect; }
    assert.equal(injected, true);
    assert.equal(snapshot.profile.displayName, 'Before');
    assert.equal(snapshot.workoutTypes[0].name, 'Before');
    await assert.rejects(repository.readAiContext('ai', revision), error => error.statusCode === 409 && error.code === 'AI_CONTEXT_STALE');
    const current = Number((await pool.query("SELECT server_revision FROM storage_roots WHERE storage_key = 'ai'")).rows[0].server_revision);
    assert.equal((await repository.readAiContext('ai', current)).profile.displayName, 'After');
  } finally {
    await closeDatabasePool(); await closeAuthResources();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }
});
