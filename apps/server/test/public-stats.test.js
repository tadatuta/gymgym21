import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.BETTER_AUTH_SECRET = 'public-stats-synthetic-test-secret';
process.env.RATE_LIMITS_ENABLED = 'false';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `public_stats_${randomUUID().replaceAll('-', '')}`;
let admin;
if (testUrl) {
  admin = new Pool({ connectionString: testUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(testUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
}
const { defaultStorageRepository: repository } = await import('../dist/storage.js');
const { getDatabasePool, closeDatabasePool, ensureDatabaseReady } = await import('../dist/database.js');
const { closeAuthResources } = await import('../dist/auth.js');
const { createApp } = await import('../dist/app.js');
const { getTrainingActivity } = await import('../dist/training-activity.js');
const fixtures = [
  { date: '2026-01-01T23:30:00-03:00' },
  { date: '2026-01-02T02:30:00Z' },
  { date: '2026-01-03T00:00:00Z', isDeleted: true },
  { date: 'invalid' },
];
test('UTC training days normalize offsets and omit tombstones/invalid dates', () => {
  assert.deepEqual([...getTrainingActivity(fixtures)], [['2026-01-02', 2]]);
});
test('PostgreSQL public HTTP statistics count all historical training days and preserve removed types', { skip: !testUrl }, async () => {
  try {
    const logs = Array.from({ length: 20 }, (_, i) => ({ id: `log${i}`, workoutTypeId: 'live', date: `2026-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`, weight: 10, reps: 2 }));
    logs.push({ id: 'same', workoutTypeId: 'deleted', date: logs[0].date, weight: 10, reps: 2 });
    logs.push({ id: 'orphan', workoutTypeId: 'missing', date: '2026-01-21T00:00:00Z', weight: 10, reps: 2 });
    logs.push({ id: 'tombstone', workoutTypeId: 'live', date: '2026-01-22T00:00:00Z', weight: 10, reps: 2, isDeleted: true });
    const data = { logs, workouts: [], workoutTypes: [{ id: 'live', name: 'Live' }, { id: 'deleted', name: 'Deleted', isDeleted: true }], profile: { id: 'me', isPublic: true, showFullHistory: false, createdAt: logs[0].date } };
    await repository.replaceSnapshot('stats', data);
    const app = createApp({ storageRepository: repository, findPublicProfile: id => repository.findPublicProfileByIdentifier(id), resolveRequestContext: async () => null, authHandler: async () => {}, generateRecommendation: async () => '' });
    const first = await request(app).get('/api/profiles/id_stats').expect(200);
    assert.equal(first.body.stats.totalWorkouts, 21);
    assert.equal(first.body.stats.totalVolume, 440);
    assert.equal(first.body.recentActivity.length, 14);
    assert.equal(first.body.logs, undefined);
    const pool = getDatabasePool();
    const cached = await pool.query("SELECT updated_at FROM public_profile_cache WHERE storage_key = 'stats'");
    assert.deepEqual((await request(app).get('/api/profiles/id_stats').expect(200)).body, first.body);
    assert.deepEqual((await pool.query("SELECT updated_at FROM public_profile_cache WHERE storage_key = 'stats'")).rows, cached.rows);
    // Simulate a deployment with an old cache at the unchanged source revision.
    await pool.query("UPDATE public_profile_cache SET payload = jsonb_set(payload, '{stats,totalWorkouts}', '999') WHERE storage_key = 'stats'");
    await pool.query("DELETE FROM app_migrations WHERE name = '003_training_days_cache.sql'");
    await closeDatabasePool();
    await ensureDatabaseReady();
    assert.equal((await repository.getPublicProfileByStorageKey('stats')).stats.totalWorkouts, 21);
    data.profile.showFullHistory = true;
    data.logs.push({ id: 'next', workoutTypeId: 'missing', date: '2026-01-23T00:00:00Z', weight: 10, reps: 2 });
    await repository.replaceSnapshot('stats', data);
    const next = await request(app).get('/api/profiles/id_stats').expect(200);
    assert.equal(next.body.stats.totalWorkouts, 22);
    assert.equal(next.body.stats.totalVolume, 460);
    assert.equal(next.body.logs.length, 23);
    assert.ok(next.body.logs.some(x => x.id === 'orphan'));
    assert.ok(next.body.logs.some(x => x.id === 'same'));
  } finally {
    await closeDatabasePool();
    await closeAuthResources();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
