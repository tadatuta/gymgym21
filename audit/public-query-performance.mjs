// Executes and EXPLAINs the production repository queries on 100k synthetic rows.
// No .env loading; requires an explicitly supplied disposable PostgreSQL URL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg');
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
assert.ok(testUrl, 'Supply the disposable GYM21_TEST_DATABASE_URL');
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
process.env.BETTER_AUTH_SECRET = 'synthetic-public-performance-secret';
const schema = `public_perf_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: testUrl });
await admin.query(`CREATE SCHEMA "${schema}"`);
const url = new URL(testUrl);
url.searchParams.set('options', `-csearch_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const { defaultStorageRepository: repository } = await import('../apps/server/dist/storage.js');
const { getDatabasePool, closeDatabasePool } = await import('../apps/server/dist/database.js');
const { closeAuthPool } = await import('../apps/server/dist/auth-meta.js');
try {
  await repository.replaceSnapshot('perf', { workoutTypes: [], workouts: [], logs: [], profile: {
    id: 'me', isPublic: true, showFullHistory: true, timeZone: 'America/Los_Angeles', createdAt: '2026-01-01T00:00:00Z',
  } });
  const pool = getDatabasePool();
  await pool.query(`INSERT INTO storage_workout_types (storage_key,id,name,updated_at,version,server_updated_at)
    SELECT 'perf','T'||lpad(n::text,6,'0'),'Exercise '||n,NOW(),n,NOW() FROM generate_series(1,100000) n`);
  await pool.query(`INSERT INTO storage_logs (storage_key,id,workout_type_id,logged_at,reps,weight,version,updated_at,server_updated_at)
    SELECT 'perf','L'||lpad(n::text,6,'0'),'T'||lpad(n::text,6,'0'),date_trunc('day',NOW()),2,3,n,NOW(),NOW() FROM generate_series(1,100000) n`);
  await pool.query('ANALYZE storage_logs');
  await pool.query('ANALYZE storage_workout_types');
  const captured = [];
  const connect = pool.connect.bind(pool);
  pool.connect = callback => {
    if (callback) return connect(callback);
    return (async () => {
      const client = await connect();
      const query = client.query.bind(client), release = client.release.bind(client);
      client.query = async (...args) => {
        const result = await query(...args);
        const sql = String(args[0]);
        if (/FROM storage_logs|FROM storage_workout_types/.test(sql)) captured.push({ sql, parameters: args[1], returnedRows: result.rows.length });
        return result;
      };
      client.release = (...args) => { client.query = query; client.release = release; release(...args); };
      return client;
    })();
  };
  try {
    const first = await repository.findPublicProfileByIdentifier('id_perf');
    assert.equal(first.logs.length, 100);
    assert.equal(first.activityDays.length, 1);
    assert.equal(first.stats.totalVolume, 600000);
    const cursor = JSON.parse(Buffer.from(first.history.nextCursor, 'base64url').toString());
    cursor.id = 'L090000';
    const deep = await repository.findPublicProfileByIdentifier('id_perf', Buffer.from(JSON.stringify(cursor)).toString('base64url'));
    assert.equal(deep.logs[0].id, 'L090001');
    await repository.readAiContext('perf');
  } finally { pool.connect = connect; }
  const queries = captured.filter((entry, index) => captured.findIndex(other => other.sql === entry.sql) === index);
  const output = { database: (await pool.query('SELECT version()')).rows[0].version, rows: 100000, plans: [] };
  async function explain(label) {
    for (const entry of queries) {
      const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${entry.sql}`, entry.parameters)).rows[0]['QUERY PLAN'];
      output.plans.push({ scenario: label, ...entry, plan });
    }
  }
  await pool.query('DROP INDEX storage_logs_recent_live_idx');
  await pool.query('DROP INDEX storage_workout_types_recent_live_idx');
  await explain('100k distinct types: before');
  await pool.query(await readFile(new URL('../apps/server/migrations/005_bounded_reads.sql', import.meta.url), 'utf8'));
  await explain('100k distinct types: indexed');
  await pool.query("UPDATE storage_logs SET workout_type_id = 'T000001'");
  await pool.query('VACUUM ANALYZE storage_logs');
  await explain('100k logs one type: indexed');
  await writeFile(new URL('./public-query-explain.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output.plans.map(({ scenario, sql, returnedRows, plan }) => ({
    scenario, query: sql.includes('COUNT(DISTINCT') ? 'summary' : sql.includes('UNION ALL') ? 'deep history' : sql.slice(0, 70),
    returnedRows, executionMs: plan[0]['Execution Time'], buffers: plan[0].Plan['Shared Hit Blocks'],
  })), null, 2));
} finally {
  await closeAuthPool(); await closeDatabasePool();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
}
