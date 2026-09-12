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
  return (batchId, cursor = 0, changes = {}, limit) => repository.sync(storageKey, { protocolVersion: 1, batchId, cursor, changes, limit }, context);
}

test('PostgreSQL: push receipts do not cache pull freshness', { skip: !testUrl }, async (t) => {
  try {
    await t.test('identical entity and batch IDs stay isolated across storage keys, including deletion, aliases and caches', async () => {
      const a = client('isolation-a');
      const b = client('isolation-b');
      const date = '2026-09-01T00:00:00.000Z';
      const changes = (owner) => ({
        workoutTypes: [entity('shared-type', owner)],
        workouts: [{ id: 'shared-workout', name: owner, startTime: date, status: 'completed', isManual: false }],
        logs: [{ id: 'shared-log', workoutTypeId: 'shared-type', workoutId: 'shared-workout', date, reps: owner === 'A' ? 2 : 7 }],
        profile: { id: 'me', displayName: owner, isPublic: true, createdAt: date, updatedAt: date },
      });
      await b('b-prior-history', 0, { workoutTypes: [entity('only-b')] });
      const firstA = await a('shared-batch', 0, changes('A'));
      const firstB = await b('shared-batch', 1, changes('B'));
      assert.equal(firstA.cursor, 4);
      assert.equal(firstB.cursor, 5);
      for (const key of ['workoutTypes', 'workouts', 'logs']) {
        assert.equal(firstB.changes[key][0].version, firstA.changes[key][0].version + 1);
      }
      assert.equal(firstB.changes.profile.version, 5);
      assert.equal(firstA.changes.profile.version, 4);
      const beforeB = await repository.readSnapshot('isolation-b');
      const publicA = await repository.findPublicProfileByIdentifier('id_isolation-a');
      const publicB = await repository.findPublicProfileByIdentifier('id_isolation-b');
      assert.equal(publicA.displayName, 'A');
      assert.equal(publicB.displayName, 'B');
      const pool = getDatabasePool();
      const rowsFor = async (table, key) => (await pool.query(`SELECT row_to_json(t) AS data FROM ${table} t WHERE storage_key = $1 ORDER BY row_to_json(t)::text`, [key])).rows;
      const cacheB = await rowsFor('public_profile_cache', 'isolation-b');
      const aliasesB = await rowsFor('public_profile_aliases', 'isolation-b');
      assert.equal(cacheB.length, 1);
      assert.equal(aliasesB.length, 1);
      assert.equal((await pool.query('SELECT * FROM storage_sync_receipts WHERE batch_id = $1', ['shared-batch'])).rowCount, 2);

      const deletions = Object.fromEntries(['workoutTypes', 'workouts', 'logs'].map(key => [key, firstA.changes[key].map(row => ({ ...row, isDeleted: true }))]));
      deletions.profile = { ...firstA.changes.profile, isDeleted: true };
      const deleted = await a('delete-a', firstA.cursor, deletions);
      assert.equal(deleted.cursor, 8);
      assert.equal((await rowsFor('public_profile_cache', 'isolation-a')).length, 0);
      assert.deepEqual(await rowsFor('public_profile_cache', 'isolation-b'), cacheB);
      assert.deepEqual(await rowsFor('public_profile_aliases', 'isolation-b'), aliasesB);
      assert.equal(await repository.findPublicProfileByIdentifier('id_isolation-a'), null);
      // Cache JSON omits optional undefined fields; compare the public wire payload.
      assert.equal(JSON.stringify(await repository.findPublicProfileByIdentifier('id_isolation-b')), JSON.stringify(publicB));

      const retryA = await a('shared-batch', 0, changes('A'));
      const retryB = await b('shared-batch', 1, changes('B'));
      assert.deepEqual(retryA.acknowledged, firstA.acknowledged);
      assert.deepEqual(retryA.conflicts, []);
      assert.equal(retryA.cursor, 8);
      for (const key of ['workoutTypes', 'workouts', 'logs']) assert.equal(retryA.changes[key][0].isDeleted, true);
      assert.equal(retryA.changes.profile.isDeleted, true);
      assert.deepEqual(retryB, firstB);
      assert.deepEqual(await repository.readSnapshot('isolation-b'), beforeB);
      const pullB = await b('empty-after-a-delete', firstB.cursor);
      assert.equal(pullB.cursor, 5);
      for (const key of ['workoutTypes', 'workouts', 'logs']) assert.deepEqual(pullB.changes[key], []);
      assert.ok(!pullB.changes.profile);
      assert.equal((await repository.readSnapshot('isolation-a')).revision, 8);
    });
    await t.test('mixed entities preserve revision order, type normalization, tombstones, conflicts and retry', async () => {
      const sync = client('mixed');
      const date = '2026-09-01T00:00:00.000Z';
      const changes = {
        workoutTypes: [{ ...entity('type'), updatedAt: undefined }, { ...entity('unknown-type'), isDeleted: true }],
        workouts: [{ id: 'workout', startTime: date, status: 'completed', isManual: false, pauseIntervals: [{ start: date, end: date }] }, { id: 'unknown-workout', startTime: date, status: 'completed', isManual: false, isDeleted: true }],
        logs: [{ id: 'log', workoutTypeId: 'type', workoutId: 'workout', date, reps: 7 }, { id: 'unknown-log', workoutTypeId: 'type', date, isDeleted: true }],
      };
      const started = Date.now();
      const initial = await sync('mixed-initial', 0, changes);
      assert.ok(Date.parse(initial.changes.workoutTypes[0].updatedAt) >= started);
      assert.ok(Date.parse(initial.changes.workoutTypes[0].updatedAt) <= Date.now());
      assert.equal(initial.cursor, 3);
      for (const [key, version] of [['workoutTypes', 1], ['workouts', 2], ['logs', 3]]) {
        assert.equal(initial.changes[key].length, 1);
        assert.equal(initial.changes[key][0].version, version);
        if (key !== 'workoutTypes') assert.equal(initial.changes[key][0].updatedAt, date);
        assert.equal(initial.changes[key][0].isDeleted, false);
      }
      assert.deepEqual(initial.changes.workouts[0].pauseIntervals, changes.workouts[0].pauseIntervals);
      const equivalent = await sync('mixed-equivalent', 3, changes);
      assert.deepEqual(equivalent.conflicts, []);
      assert.equal(equivalent.cursor, 3);
      const different = {
        workoutTypes: changes.workoutTypes.map(x => x.id === 'type' ? { ...x, name: 'Edited type' } : x),
        workouts: changes.workouts.map(x => x.id === 'workout' ? { ...x, name: 'Edited workout' } : x),
        logs: changes.logs.map(x => x.id === 'log' ? { ...x, reps: 8 } : x),
      };
      const conflict = await sync('mixed-stale', 3, different);
      assert.deepEqual(conflict.conflicts.map(x => [x.entityType, x.serverVersion]), [['workoutTypes', 1], ['workouts', 2], ['logs', 3]]);
      const edits = Object.fromEntries(['workoutTypes', 'workouts', 'logs'].map(key => [key, initial.changes[key].map(x => ({ ...x, isDeleted: true }))]));
      await sync('mixed-delete', 3, edits);
      const retry = await sync('mixed-stale', 6, different);
      assert.equal(retry.cursor, 6);
      assert.deepEqual(retry.acknowledged, conflict.acknowledged);
      assert.deepEqual(retry.conflicts.map(x => [x.entityType, x.serverVersion]), [['workoutTypes', 4], ['workouts', 5], ['logs', 6]]);
      for (const key of ['workoutTypes', 'workouts', 'logs']) assert.equal(retry.changes[key][0].isDeleted, true);
      assert.equal((await repository.readSnapshot('mixed')).revision, 6);
    });
    await t.test('late SQL failure rolls back every entity, root, aliases, cache and receipt', async () => {
      const sync = client('rollback');
      const initial = await sync('seed', 0, { workoutTypes: [entity('seed')], profile: { id: 'me', isPublic: true, displayName: 'Before', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' } });
      await repository.getPublicProfileByStorageKey('rollback');
      const before = await repository.readSnapshot('rollback');
      const pool = getDatabasePool();
      const tables = ['storage_roots', 'storage_profiles', 'storage_workout_types', 'storage_workouts', 'storage_logs', 'public_profile_aliases', 'public_profile_cache', 'storage_sync_receipts'];
      const stored = async () => Promise.all(tables.map(async table => (await pool.query(`SELECT row_to_json(t) AS data FROM ${table} t WHERE storage_key = $1 ORDER BY row_to_json(t)::text`, ['rollback'])).rows));
      const beforeRows = await stored();
      await pool.query(`CREATE FUNCTION reject_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt failure'; END $$`);
      await pool.query(`CREATE TRIGGER reject_test_receipt BEFORE INSERT ON storage_sync_receipts FOR EACH ROW WHEN (NEW.batch_id = 'rollback-fail') EXECUTE FUNCTION reject_test_receipt()`);
      try {
        await assert.rejects(sync('rollback-fail', initial.cursor, {
          workoutTypes: [entity('new-type')],
          workouts: [{ id: 'new-workout', startTime: '2026-09-01T00:00:00Z', status: 'completed', isManual: false }],
          logs: [{ id: 'new-log', workoutTypeId: 'new-type', date: '2026-09-01T00:00:00Z' }],
          profile: { ...before.profile, displayName: 'Must roll back', isPublic: false },
        }), /test receipt failure/);
        assert.deepEqual(await repository.readSnapshot('rollback'), before);
        assert.deepEqual(await stored(), beforeRows);
        assert.equal((await pool.query("SELECT * FROM storage_sync_receipts WHERE batch_id = 'rollback-fail'")).rowCount, 0);
      } finally { await pool.query('DROP TRIGGER reject_test_receipt ON storage_sync_receipts'); await pool.query('DROP FUNCTION reject_test_receipt()'); }
    });
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
