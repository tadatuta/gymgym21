import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
process.env.BETTER_AUTH_SECRET = 'bounded-read-synthetic-test-secret';
process.env.AI_MAX_EXERCISE_COUNT = '3';
process.env.AI_MAX_RECENT_LOGS = '7';
const schema = `bounded_${randomUUID().replaceAll('-', '')}`;
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
const { closeAuthPool } = await import('../dist/auth-meta.js');
const { publicProfileSchema } = await import('@gym21/contracts');

test('public SQL aggregates, bounded keyset pages, privacy/revision/cache snapshots and SQL AI caps', { skip: !testUrl }, async () => {
  try {
    const profile = { id: 'me', isPublic: true, showFullHistory: true, timeZone: 'America/Los_Angeles', createdAt: '2026-01-01T00:00:00Z' };
    const logs = Array.from({ length: 205 }, (_, index) => ({
      id: `L${String(index).padStart(3, '0')}`, workoutTypeId: index % 2 ? 'B' : 'A',
      date: '2026-09-01T06:30:00Z', reps: 2, weight: 3,
    }));
    const types = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, name: id, updatedAt: '2026-09-01T00:00:00Z' }));
    const data = { profile, workoutTypes: types, workouts: [], logs: [...logs,
      { id: 'orphan', workoutTypeId: 'removed', date: '2026-08-02T06:00:00Z', reps: 4, weight: 5 },
      { id: 'zero', workoutTypeId: 'C', date: '2026-08-01T23:00:00Z', reps: 2, weight: 0, duration: 1, durationSeconds: 7 },
      { id: 'deleted', workoutTypeId: 'A', date: '2026-09-03T00:00:00Z', isDeleted: true, reps: 99, weight: 99 },
    ] };
    await repository.replaceSnapshot('public', data);
    const pool = getDatabasePool();
    const first = await repository.findPublicProfileByIdentifier('id_public');
    assert.equal(first.logs.length, 100);
    assert.deepEqual(first.stats, { totalWorkouts: 2, totalVolume: 1250, favoriteExercise: 'A', lastWorkoutDate: '2026-09-01T06:30:00.000Z' });
    assert.deepEqual(first.recentActivity, [{ date: '2026-08-01', exerciseCount: 2 }, { date: '2026-08-31', exerciseCount: 205 }]);
    assert.ok(!first.logs.some(log => log.id === 'orphan'));
    assert.deepEqual(first, publicProfileSchema.parse(first));
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(first.logs[0]))).sort(), ['date', 'id', 'reps', 'weight', 'workoutTypeId']);
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(first.workoutTypes[0]))).sort(), ['id', 'name']);
    const cursor = first.history.nextCursor;
    const second = await repository.findPublicProfileByIdentifier('id_public', cursor);
    const third = await repository.findPublicProfileByIdentifier('id_public', second.history.nextCursor);
    assert.equal(third.history.nextCursor, null);
    assert.deepEqual([...first.logs, ...second.logs, ...third.logs].map(log => log.id), [...logs.map(log => log.id), 'orphan', 'zero']);
    assert.equal(third.logs.find(log => log.id === 'zero').weight, 0);
    assert.equal(third.logs.find(log => log.id === 'zero').durationSeconds, 7);
    // A direct read with a different anonymous fallback must not inherit cached alias text.
    assert.equal((await repository.getPublicProfileByStorageKey('public', 'different')).identifier, 'different');
    assert.equal((await repository.getPublicProfileByStorageKey('public', 'different')).displayName, 'different');
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    for (const patch of [{ at: '2026-02-31T00:00:00.000000Z' }, { at: '0000-01-01T00:00:00.000000Z' }, { id: '\0' }, { id: ' ' }, { revision: -1 }]) {
      await assert.rejects(repository.findPublicProfileByIdentifier('id_public', Buffer.from(JSON.stringify({ ...parsed, ...patch })).toString('base64url')), error => error.statusCode === 400);
    }
    await assert.rejects(repository.findPublicProfileByIdentifier('id_public', 'bad'), error => error.statusCode === 400);
    await repository.replaceSnapshot('other', data);
    await assert.rejects(repository.findPublicProfileByIdentifier('id_other', cursor), error => error.statusCode === 400);
    const ai = await repository.readAiContext('public');
    assert.equal(ai.workoutTypes.length, 3);
    assert.equal(ai.logs.length, 7);
    assert.equal('workouts' in ai, false);
    assert.equal(ai.profile.timeZone, profile.timeZone);

    // Tied exercise frequencies use the first encounter in date DESC, id ASC.
    await pool.query("UPDATE storage_logs SET is_deleted = TRUE WHERE storage_key = 'public' AND id = 'L204'");
    await pool.query("UPDATE storage_roots SET server_revision = server_revision + 1 WHERE storage_key = 'public'");
    assert.equal((await repository.findPublicProfileByIdentifier('id_public')).stats.favoriteExercise, 'A');
    await assert.rejects(repository.findPublicProfileByIdentifier('id_public', cursor), error => error.statusCode === 409 && error.code === 'PUBLIC_HISTORY_STALE');
    await pool.query("UPDATE storage_workout_types SET is_deleted = TRUE WHERE storage_key = 'public' AND id = 'A'");
    await pool.query("UPDATE storage_roots SET server_revision = server_revision + 1 WHERE storage_key = 'public'");
    assert.equal((await repository.findPublicProfileByIdentifier('id_public')).stats.favoriteExercise, undefined);

    // Cache miss may scan aggregates, but hidden history never selects raw logs/types.
    await repository.replaceSnapshot('public', { ...data, profile: { ...profile, showFullHistory: false } });
    const connect = pool.connect.bind(pool);
    const statements = [];
    pool.connect = (callback) => {
      if (callback) return connect(callback);
      return (async () => {
      const client = await connect();
      const query = client.query.bind(client), release = client.release.bind(client);
      client.query = async (...args) => { statements.push(String(args[0])); return query(...args); };
      client.release = (...args) => { client.query = query; client.release = release; release(...args); };
      return client;
      })();
    };
    let hidden;
    try { hidden = await repository.findPublicProfileByIdentifier('id_public'); }
    finally { pool.connect = connect; }
    assert.equal('logs' in hidden, false);
    assert.equal('workoutTypes' in hidden, false);
    assert.equal('activityDays' in hidden, false);
    assert.equal('history' in hidden, false);
    assert.ok(!statements.some(sql => /SELECT \* FROM storage_(logs|workout_types)|SELECT id, workout_type_id/.test(sql)));
    await repository.replaceSnapshot('public', { ...data, profile: { ...profile, isPublic: false } });
    assert.equal(await repository.findPublicProfileByIdentifier('id_public', cursor), null);

    // Interleave a committed writer after the root snapshot: profile/cache/data stay at the same revision.
    await repository.replaceSnapshot('public', data);
    let injected = false;
    pool.connect = (callback) => {
      if (callback) return connect(callback);
      return (async () => {
      const client = await connect();
      const query = client.query.bind(client), release = client.release.bind(client);
      client.query = async (...args) => {
        const result = await query(...args);
        if (!injected && String(args[0]).startsWith('SELECT server_revision FROM storage_roots')) {
          injected = true;
          await repository.replaceSnapshot('public', { ...data, logs: [], profile: { ...profile, displayName: 'After' } });
          await repository.findPublicProfileByIdentifier('id_public');
        }
        return result;
      };
      client.release = (...args) => { client.query = query; client.release = release; release(...args); };
      return client;
      })();
    };
    let before;
    try { before = await repository.findPublicProfileByIdentifier('id_public'); }
    finally { pool.connect = connect; }
    assert.equal(injected, true);
    assert.equal(before.displayName, 'id_public');
    assert.equal(before.logs.length, 100);
    const after = await repository.findPublicProfileByIdentifier('id_public');
    assert.equal(after.displayName, 'After');
    assert.equal(after.logs.length, 0);
    const cached = (await pool.query("SELECT c.source_revision = r.server_revision AS current FROM public_profile_cache c JOIN storage_roots r USING (storage_key) WHERE storage_key = 'public'")).rows[0];
    assert.equal(cached.current, true);

    // Recent means active days, not the last 14 calendar days; precision ties remain pageable.
    await repository.replaceSnapshot('days', { ...data, logs: Array.from({ length: 20 }, (_, i) => ({
      id: `day${i}`, workoutTypeId: 'A', date: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    })) });
    const days = await repository.findPublicProfileByIdentifier('id_days');
    assert.equal(days.stats.totalWorkouts, 20);
    assert.equal(days.recentActivity.length, 14);
    assert.equal(days.recentActivity[0].date, '2026-01-06');
    await pool.query("UPDATE storage_logs SET logged_at = '2026-09-01T06:30:00.123456Z' WHERE storage_key = 'other'");
    await pool.query("UPDATE storage_roots SET server_revision = server_revision + 1 WHERE storage_key = 'other'");
    const microFirst = await repository.findPublicProfileByIdentifier('id_other');
    const microSecond = await repository.findPublicProfileByIdentifier('id_other', microFirst.history.nextCursor);
    assert.equal(new Set([...microFirst.logs, ...microSecond.logs].map(log => log.id)).size, 200);
    assert.equal(JSON.parse(Buffer.from(microFirst.history.nextCursor, 'base64url').toString()).at, '2026-09-01T06:30:00.123456Z');
    await pool.query("UPDATE storage_logs SET logged_at = NOW() WHERE storage_key = 'days'");
    await pool.query("UPDATE storage_roots SET server_revision = server_revision + 1 WHERE storage_key = 'days'");
    const today = (await pool.query("SELECT to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS day")).rows[0].day;
    assert.deepEqual((await repository.findPublicProfileByIdentifier('id_days')).activityDays, [today]);
    await pool.query("UPDATE storage_logs SET logged_at = CASE WHEN id = 'orphan' THEN NOW() - INTERVAL '2 days' ELSE NOW() END WHERE storage_key = 'other'");
    await pool.query("UPDATE storage_roots SET server_revision = server_revision + 1 WHERE storage_key = 'other'");
    const earlierDay = (await pool.query("SELECT to_char((NOW() - INTERVAL '2 days') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS day")).rows[0].day;
    const window = await repository.findPublicProfileByIdentifier('id_other');
    assert.equal(window.logs.length, 100);
    assert.ok(!window.logs.some(log => log.id === 'orphan'));
    assert.ok(window.activityDays.includes(earlierDay));
  } finally {
    await closeAuthPool(); await closeDatabasePool();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }
});
