import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';

process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.BETTER_AUTH_SECRET = 'sync-receipt-regression-test-secret';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `sync_receipts_${randomUUID().replaceAll('-', '')}`;
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
const entity = (id, name = id, version = 0) => ({ id, name, version, category: 'time', updatedAt: '2026-09-01T00:00:00.000Z' });
function client(storageKey) {
  const context = { kind: 'better-auth', storageKey, authUser: { id: storageKey, username: null } };
  return (batchId, cursor = 0, changes = {}, limit) => repository.sync(storageKey, { batchId, cursor, changes, limit }, context);
}

test('PostgreSQL: push receipts do not cache pull freshness', { skip: !testUrl }, async (t) => {
  try {
    await t.test('oversized count and UTF-8 push are rejected before writing', async () => {
      const sync = client('limits');
      await assert.rejects(sync('count', 0, { workoutTypes: Array.from({ length: 501 }, (_, i) => entity(`T${i}`)) }), { statusCode: 413 });
      await assert.rejects(sync('bytes', 0, { workouts: [{ id: 'W', name: 'я'.repeat(270000), date: '2026-09-01', updatedAt: '2026-09-01T00:00:00Z' }] }), { statusCode: 413 });
      assert.equal((await sync('check')).cursor, 0);
    });
    await t.test('push plus paged pull preserves remote cursor and submitted authoritative versions on retry', async () => {
      const sync = client('paged-push');
      await sync('remote-seed', 0, { workoutTypes: Array.from({ length: 9 }, (_, i) => entity(`remote-${i}`)) });
      const changes = { workoutTypes: [entity('local')] };
      const first = await sync('local-batch', 0, changes, 2);
      assert.equal(first.cursor, 2);
      assert.equal(first.hasMore, true);
      assert.equal(first.changes.workoutTypes.length, 3);
      assert.equal(first.changes.workoutTypes.find(x => x.id === 'local').version, 10);
      const retry = await sync('local-batch', 0, changes, 2);
      assert.deepEqual(retry, first);
      const seen = new Set(first.changes.workoutTypes.map(x => x.id));
      let page = first;
      let rounds = 0;
      while (page.hasMore) {
        page = await sync(`more-${rounds++}`, page.cursor, {}, 2);
        assert.ok(page.changes.workoutTypes.length <= 2);
        for (const x of page.changes.workoutTypes) seen.add(x.id);
      }
      assert.equal(page.cursor, 10);
      assert.equal(seen.size, 10);
    });
    await t.test('two clients: repeated empty batch sees remote writes and ignores legacy empty receipts', async () => {
      const a = client('empty-pull');
      const b = client('empty-pull');
      const empty = await a('same-empty-batch');
      assert.equal(empty.cursor, 0);
      assert.equal((await getDatabasePool().query("SELECT * FROM storage_sync_receipts WHERE storage_key = 'empty-pull'")).rowCount, 0);
      // Simulate a receipt left by the previous server version, including an expired one.
      await getDatabasePool().query(`INSERT INTO storage_sync_receipts (storage_key, batch_id, response_payload, created_at)
        VALUES ($1, $2, $3::jsonb, NOW() - INTERVAL '31 days')`, ['empty-pull', 'same-empty-batch', JSON.stringify(empty)]);
      await b('remote-1', 0, { workoutTypes: [entity('remote-1')] });
      const pulled = await a('same-empty-batch');
      assert.equal(pulled.cursor, 1);
      assert.equal(pulled.changes.workoutTypes[0].id, 'remote-1');
      await a('at-one', 1);
      await b('remote-2', 1, { workoutTypes: [entity('remote-2')] });
      assert.equal((await a('at-one', 1)).changes.workoutTypes[0].id, 'remote-2');
      assert.equal((await getDatabasePool().query("SELECT * FROM storage_sync_receipts WHERE batch_id = 'at-one'")).rowCount, 0);
    });
    await t.test('lost push response: retry keeps acknowledgements, skips writes, and pulls newer remote versions', async () => {
      const a = client('lost-response');
      const b = client('lost-response');
      const changes = { workoutTypes: [entity('local')] };
      const lost = await a('push-generation-1', 0, changes);
      await b('remote-edit', lost.cursor, { workoutTypes: [entity('local', 'edited remotely', 1), entity('remote')] });
      const retry = await a('push-generation-1', 0, changes);
      assert.equal(retry.cursor, 3);
      assert.deepEqual(retry.acknowledged, lost.acknowledged);
      assert.deepEqual(retry.conflicts, []);
      assert.equal(retry.changes.workoutTypes.find((item) => item.id === 'local').name, 'edited remotely');
      assert.equal(retry.changes.workoutTypes.find((item) => item.id === 'local').version, 2);
      assert.equal(retry.changes.workoutTypes.find((item) => item.id === 'remote').version, 3);
      assert.equal((await repository.readSnapshot('lost-response')).revision, 3);
      // Even an advanced cursor must return submitted entities for outbox-generation rebasing.
      const advanced = await a('push-generation-1', 3, changes, 1);
      assert.equal(advanced.changes.workoutTypes[0].version, 2);
      assert.deepEqual(advanced.acknowledged, lost.acknowledged);
      const payload = (await getDatabasePool().query("SELECT response_payload FROM storage_sync_receipts WHERE storage_key = 'lost-response' AND batch_id = 'push-generation-1'")).rows[0].response_payload;
      assert.deepEqual(Object.keys(payload).sort(), ['acknowledged', 'conflicts']);
      // Existing full-response push receipts must also produce a fresh pull.
      await getDatabasePool().query("UPDATE storage_sync_receipts SET response_payload = $1::jsonb WHERE storage_key = 'lost-response' AND batch_id = 'push-generation-1'", [JSON.stringify(lost)]);
      assert.equal((await a('push-generation-1', 0, changes)).cursor, 3);
    });
    await t.test('conflict retry preserves outcome but returns the current authoritative entity', async () => {
      const a = client('conflict-retry');
      await a('initial', 0, { workoutTypes: [entity('item')] });
      const staleChanges = { workoutTypes: [entity('item', 'stale')] };
      const lost = await a('stale-push', 1, staleChanges);
      await a('new-edit', 1, { workoutTypes: [entity('item', 'newest', 1)] });
      const retry = await a('stale-push', 2, staleChanges);
      assert.deepEqual(retry.conflicts, lost.conflicts.map((conflict) => ({ ...conflict, serverVersion: 2 })));
      assert.deepEqual(retry.acknowledged, lost.acknowledged);
      assert.equal(retry.changes.workoutTypes[0].name, 'newest');
      assert.equal(retry.changes.workoutTypes[0].version, 2);
    });
    await t.test('concurrent retries apply a batch only once', async () => {
      const a = client('concurrent');
      const results = await Promise.all(Array.from({ length: 4 }, () => a('one-batch', 0, { workoutTypes: [entity('once')] })));
      for (const result of results) {
        assert.equal(result.cursor, 1);
        assert.deepEqual(result.conflicts, []);
      }
      assert.equal((await repository.readSnapshot('concurrent')).revision, 1);
    });
  } finally {
    await closeAuthResources();
    await closeDatabasePool();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
