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
  return (batchId, cursor = 0, changes = {}, limit) => repository.sync(storageKey, { protocolVersion: 1, batchId, cursor, changes, limit }, context);
}

const { createMemoryRateLimitStore } = await import('../dist/http/middleware/rate-limit-store.js');
const { createApp } = await import('../dist/app.js');
function api(storageKey) {
  const context = { kind: 'better-auth', storageKey, authUser: { id: storageKey, username: 'trusted' } };
  const app = createApp({ rateLimitStore: createMemoryRateLimitStore(), storageRepository: repository, resolveRequestContext: async () => context,
    authHandler: async () => {}, generateRecommendation: async () => '', findPublicProfile: async () => null });
  return (mode, expectedRevision, data, expectedKey = storageKey) => request(app).post('/api/me/storage/backup')
    .set('X-Expected-Storage-Key', expectedKey).send({ mode, expectedRevision, data });
}
const backup = { workoutTypes: [entity('A', 'modified A', 99999)], workouts: [], logs: [] };
test('PostgreSQL backup import is atomic and revision guarded', { skip: !testUrl }, async (t) => {
  try {
    await t.test('HTTP sync validates atomically and normalizes cleared birth date before PostgreSQL', async () => {
      const storageKey = 'sync-contract';
      const context = { kind: 'better-auth', storageKey, authUser: { id: storageKey, username: 'trusted' } };
      const app = createApp({ rateLimitStore: createMemoryRateLimitStore(), storageRepository: repository, resolveRequestContext: async () => context,
        authHandler: async () => {}, generateRecommendation: async () => '', findPublicProfile: async () => null });
      const send = body => request(app).post('/api/me/storage/sync').set('X-Expected-Storage-Key', storageKey).send(body);
      const now = '2026-09-01T00:00:00Z';
      const profile = { id: 'me', isPublic: false, createdAt: now, updatedAt: now, birthDate: '', username: 'forged' };
      const saved = await send({ protocolVersion: 1, cursor: 0, changes: { profile } });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.changes.profile.birthDate, undefined);
      assert.equal(saved.body.changes.profile.username, 'trusted');
      const revision = saved.body.cursor;
      const malformed = [
        { profile: { ...profile, id: 'other' } }, { profile: { ...profile, birthDate: '2026-02-30' } },
        { profile: { ...profile, gender: 'bogus' } }, { profile: { ...profile, height: -1 } },
        { workoutTypes: [entity(''), entity('valid')] }, { workoutTypes: [entity('A'), entity('A')] },
        { workoutTypes: [entity(' '.repeat(2))] }, { workoutTypes: [entity('x'.repeat(201))] },
        { logs: [{ id: 'L', workoutTypeId: 'orphan', date: '2026-02-30T00:00:00Z' }] },
        { logs: [{ id: 'L', workoutTypeId: 'orphan', date: now, reps: 1.5 }] },
        { logs: [{ id: 'L', workoutTypeId: 'orphan', date: now, weight: -1 }] },
        { logs: [{ id: 'L', workoutTypeId: 'orphan', date: now, durationSeconds: 60 }] },
        { workoutTypes: [{ ...entity('A'), version: Number.MAX_SAFE_INTEGER + 1 }] },
        { workouts: [{ id: 'W', startTime: now, status: 'bogus', isManual: false, pauseIntervals: [] }] },
      ];
      for (const changes of malformed) {
        const response = await send({ protocolVersion: 1, cursor: revision, changes: { ...changes, workouts: changes.workouts ?? [{ id: 'valid', startTime: now, status: 'active', isManual: false, pauseIntervals: [] }] } });
        assert.equal(response.status, 400, JSON.stringify(changes));
        assert.equal(response.body.code, 'INVALID_REQUEST');
        assert.equal((await client(storageKey)('verify', revision)).cursor, revision);
      }
      const badJson = await request(app).post('/api/me/storage/sync').set('Content-Type', 'application/json').send('{"invalid":');
      assert.equal(badJson.status, 400);
      assert.equal(badJson.body.code, 'INVALID_JSON');
      const beforeProtocol = await repository.readSnapshot(storageKey);
      for (const protocolVersion of [undefined, 2]) {
        const rejected = await send({ protocolVersion, cursor: revision, changes: { workoutTypes: [entity('protocol-must-not-write')] } });
        assert.equal(rejected.status, protocolVersion === undefined ? 400 : 409);
        assert.equal(rejected.body.code, protocolVersion === undefined ? 'INVALID_REQUEST' : 'UNSUPPORTED_PROTOCOL');
        assert.deepEqual(await repository.readSnapshot(storageKey), beforeProtocol);
      }
      assert.equal((await send({ protocolVersion: 1, cursor: Number.MAX_SAFE_INTEGER + 1, changes: {} })).status, 400);
      assert.equal((await client(storageKey)('final', revision)).cursor, revision);
    });
    await t.test('atomic HTTP backup accepts 10001 valid logs and reports body limit without truncation', async () => {
      const logs = Array.from({ length: 10001 }, (_, i) => ({ id: `L${i}`, workoutTypeId: 'T', date: '2026-09-01T00:00:00Z', reps: 1 }));
      const imported = await api('large-backup')('replace', 0, { workoutTypes: [], workouts: [], logs });
      assert.equal(imported.status, 200, JSON.stringify(imported.body).slice(0, 500));
      assert.equal(imported.body.changes.logs.length, 10001);
      const tooLarge = await api('large-backup')('replace', imported.body.cursor, { workoutTypes: [], workouts: [], logs, padding: 'x'.repeat(11 * 1024 * 1024) });
      assert.equal(tooLarge.status, 413);
      assert.equal(tooLarge.body.code, 'payload_too_large');
      let saved = await client('large-backup')('check');
      assert.equal(saved.changes.logs.length, 1000);
      let count = saved.changes.logs.length;
      while (saved.hasMore) { saved = await client('large-backup')('check', saved.cursor); count += saved.changes.logs.length; }
      assert.equal(count, 10001);
      assert.equal(saved.cursor, imported.body.cursor);
    });
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
    await t.test('malformed backup fields always return 400 before any PostgreSQL changes', async () => {
      const key = 'malformed-fields';
      const initial = await client(key)('init', 0, { workoutTypes: [entity('A')] });
      const before = await repository.readSnapshot(key);
      const now = '2026-09-01T00:00:00Z';
      const log = { id: 'L', workoutTypeId: 'A', workoutId: 'orphan', date: now, weight: 10, reps: 1 };
      const workout = { id: 'W', startTime: now, status: 'finished', isManual: true, pauseIntervals: [] };
      const profile = { id: 'me', createdAt: now, isPublic: false };
      const malformed = [
        ...['<img>', null, -1, 1e30].map((weight) => ({ ...backup, logs: [{ ...log, weight }] })),
        ...['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-09-01', '0000-01-01T00:00:00Z'].map((date) => ({ ...backup, logs: [{ ...log, date }] })),
        { ...backup, logs: [{ ...log, reps: 0.5 }] },
        { ...backup, logs: [{ ...log, durationSeconds: 60 }] },
        { ...backup, logs: [{ ...log, workoutTypeId: {} }] },
        { ...backup, logs: [{ ...log, workoutId: [] }] },
        { ...backup, logs: [log, log] },
        { ...backup, logs: [{ ...log, id: ' '.repeat(3) }] },
        { ...backup, logs: [{ ...log, id: 'x'.repeat(201) }] },
        { ...backup, workoutTypes: [null] },
        { ...backup, workoutTypes: [{ ...entity('A'), order: 2147483648 }] },
        { ...backup, workoutTypes: [{ ...entity('A'), name: 'bad\0name' }] },
        { ...backup, workouts: [{ ...workout, pauseIntervals: [{ start: now, end: '2026-02-30T00:00:00Z' }] }] },
        { ...backup, workouts: [{ ...workout, status: 'unknown' }] },
        { ...backup, profile: [] },
        { ...backup, profile: { ...profile, birthDate: '2026-02-30' } },
        { ...backup, profile: { ...profile, height: -1 } },
        { ...backup, profile: { ...profile, friends: [{ identifier: 'friend', displayName: 'Friend', addedAt: 'yesterday' }] } },
      ];
      for (const mode of ['merge', 'replace']) for (const data of malformed) {
        const response = await api(key)(mode, initial.cursor, data);
        assert.equal(response.status, 400, JSON.stringify({ data, response: response.body }));
        assert.deepEqual(await repository.readSnapshot(key), before);
      }
    });
    await t.test('valid orphan references and cleared birth date roundtrip in both modes', async () => {
      const now = '2026-09-01T00:00:00Z';
      for (const mode of ['merge', 'replace']) {
        const key = `orphans-${mode}`;
        const data = { workoutTypes: [], workouts: [], logs: [{ id: 'L', workoutTypeId: 'deleted-type', workoutId: 'legacy-workout', date: now, weight: 0, reps: 0 }],
          profile: { id: 'me', isPublic: false, createdAt: now, birthDate: '' } };
        const response = await api(key)(mode, 0, data);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const snapshot = await repository.readSnapshot(key);
        assert.equal(snapshot.logs[0].workoutTypeId, 'deleted-type');
        assert.equal(snapshot.logs[0].workoutId, 'legacy-workout');
        assert.equal(snapshot.profile.birthDate, undefined);
        assert.deepEqual(snapshot.workoutTypes, []);
      }
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
