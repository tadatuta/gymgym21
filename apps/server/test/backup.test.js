import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { Pool } from 'pg';

process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.BETTER_AUTH_SECRET = 'sync-receipt-regression-test-secret';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `backup_${randomUUID().replaceAll('-', '')}`;
let admin;
if (testUrl) {
  admin = new Pool({ connectionString: testUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(testUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
}
const { defaultStorageRepository: repository } = await import('../dist/storage.js');
const { closeDatabasePool } = await import('../dist/database.js');
const { closeAuthResources } = await import('../dist/auth.js');
const entity = (id, name = id, version = 0) => ({ id, name, version, category: 'time', updatedAt: '2026-09-01T00:00:00.000Z' });
function client(storageKey) {
  const context = { kind: 'better-auth', storageKey, authUser: { id: storageKey, username: null } };
  return (batchId, cursor = 0, changes = {}, limit) => repository.sync(storageKey, { batchId, cursor, changes, limit }, context);
}

const { createApp } = await import('../dist/app.js');
function api(storageKey) {
  const context = { kind: 'better-auth', storageKey, authUser: { id: storageKey, username: 'trusted' } };
  const app = createApp({ storageRepository: repository, resolveRequestContext: async () => context,
    authHandler: async () => {}, generateRecommendation: async () => '', findPublicProfile: async () => null });
  return (mode, expectedRevision, data, expectedKey = storageKey) => request(app).post('/api/me/storage/backup')
    .set('X-Expected-Storage-Key', expectedKey).send({ mode, expectedRevision, data });
}
const backup = { workoutTypes: [entity('A', 'modified A', 99999)], workouts: [], logs: [] };
test('PostgreSQL backup import is atomic and revision guarded', { skip: !testUrl }, async (t) => {
  try {
    for (const mode of ['merge', 'replace']) await t.test(`${mode}: old backup versions, two-client roundtrip and tombstones`, async () => {
      const key = `backup-${mode}`;
      const a = client(key), b = client(key);
      const before = await a('initial', 0, { workoutTypes: [entity('A'), entity('B')] });
      const response = await api(key)(mode, before.cursor, backup);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body.conflicts, []);
      const remote = await b('pull', before.cursor);
      assert.equal(remote.changes.workoutTypes.find((x) => x.id === 'A').name, 'modified A');
      assert.equal(remote.changes.workoutTypes.find((x) => x.id === 'A').version, 3);
      const snapshot = await repository.readSnapshot(key);
      assert.equal(snapshot.workoutTypes.find((x) => x.id === 'B').isDeleted, mode === 'replace');
      if (mode === 'replace') assert.equal(remote.changes.workoutTypes.find((x) => x.id === 'B').isDeleted, true);
    });
    await t.test('empty replace propagates tombstones for workouts, logs and profile; imports cannot forge identity', async () => {
      const key = 'all-entities';
      const a = client(key), b = client(key);
      const now = '2026-09-01T00:00:00Z';
      const initial = await a('initial', 0, {
        workoutTypes: [entity('A')],
        workouts: [{ id: 'W', startTime: now, status: 'finished', isManual: true, pauseIntervals: [] }],
        logs: [{ id: 'L', workoutTypeId: 'A', workoutId: 'W', date: now, reps: 1 }],
        profile: { id: 'me', isPublic: true, createdAt: now, displayName: 'original' },
      });
      const merged = await api(key)('merge', initial.cursor, { workoutTypes: [], logs: [], workouts: [],
        profile: { id: 'foreign', isPublic: true, createdAt: now, displayName: 'imported', username: 'forged', telegramUsername: 'forged', telegramUserId: 999, version: 99999 } });
      assert.equal(merged.status, 200, JSON.stringify(merged.body));
      assert.equal(merged.body.changes.profile.username, 'trusted');
      assert.notEqual(merged.body.changes.profile.telegramUserId, 999);
      assert.equal(merged.body.changes.profile.id, 'me');
      const removed = await api(key)('replace', merged.body.cursor, { workoutTypes: [], logs: [], workouts: [] });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      const pulled = await b('after-replace', merged.body.cursor);
      for (const kind of ['workoutTypes', 'logs', 'workouts']) assert.equal(pulled.changes[kind][0].isDeleted, true);
      assert.equal(pulled.changes.profile.isDeleted, true);
    });
    await t.test('concurrent replace against the same revision: exactly one succeeds, loser changes nothing', async () => {
      const key = 'concurrent-backup';
      const before = await client(key)('init', 0, { workoutTypes: [entity('A'), entity('B')] });
      const responses = await Promise.all(['one', 'two'].map((name) => api(key)('replace', before.cursor,
        { ...backup, workoutTypes: [entity(name)] })));
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      const snapshot = await repository.readSnapshot(key);
      const winner = responses[0].status === 200 ? 'one' : 'two';
      assert.deepEqual(snapshot.workoutTypes.filter((x) => !x.isDeleted).map((x) => x.id), [winner]);
      const rejected = await api(key)('replace', before.cursor, backup);
      assert.equal(rejected.status, 409);
      assert.deepEqual(await repository.readSnapshot(key), snapshot);
    });
    await t.test('endpoint rejects invalid payload and wrong account without changes', async () => {
      const key = 'invalid-backup';
      await client(key)('init', 0, { workoutTypes: [entity('A')] });
      const before = await repository.readSnapshot(key);
      assert.equal((await api(key)('replace', 1, { ...backup, logs: [{ id: 'bad', weight: '<script>' }] })).status, 400);
      assert.equal((await api(key)('replace', 1, { ...backup, workoutTypes: [entity('A'), entity('A')] })).status, 400);
      assert.equal((await api(key)('replace', 1, backup, 'other')).status, 409);
      assert.deepEqual(await repository.readSnapshot(key), before);
    });
  } finally {
    await closeAuthResources();
    await closeDatabasePool();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
