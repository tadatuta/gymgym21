import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backupDataSchema, backupEnvelopeSchema, backupImportSchema,
  syncEntitySchemas, syncRequestSchema, syncResponseSchema, publicProfileSchema,
} from '@gym21/contracts';
import { validTimeZone, accountTimeZone, dayKey } from '@gym21/contracts/training-time';

const date = '2026-09-01T12:00:00Z';
const type = { id: 'type', name: 'Squat', category: 'strength' };
const log = { id: 'log', workoutTypeId: 'deleted-type', date, weight: 0, reps: 0 };
const workout = { id: 'workout', startTime: date, status: 'active', isManual: false, pauseIntervals: [] };
const profile = { id: 'me', isPublic: false, createdAt: date, birthDate: '' };
const data = () => ({ workoutTypes: [type], logs: [log], workouts: [workout], profile });
const request = changes => ({ cursor: 0, changes });
const response = changes => ({ cursor: 0, changes, conflicts: [] });

// These fixtures execute the same exported runtime schemas used by the HTTP
// routes and browser validators, including the intentional boundary differences.
test('backup and sync share historical entity rules, orphan references and omitted metadata', () => {
  assert(backupDataSchema.safeParse(data()).success);
  assert(syncRequestSchema.safeParse(request(data())).success);
  assert(syncResponseSchema.safeParse(response(data())).success);
  for (const [key, entity] of Object.entries({ workoutTypes: type, logs: log, workouts: workout, profile })) {
    assert(syncEntitySchemas[key].safeParse(entity).success, key);
  }
  assert.equal(syncRequestSchema.parse(request(data())).changes.profile.birthDate, undefined);
});

test('profile write/backup strip identity while sync response retains verified identity', () => {
  const identity = { username: 'owner', telegramUsername: 'verified', telegramUserId: 123 };
  const changes = { ...data(), profile: { ...profile, ...identity } };
  for (const parsed of [backupDataSchema.parse(changes), syncRequestSchema.parse(request(changes)).changes,
    backupImportSchema.parse({ mode: 'replace', expectedRevision: 0, data: changes }).data]) {
    for (const key of Object.keys(identity)) assert.equal(Object.hasOwn(parsed.profile, key), false, key);
  }
  const returned = syncResponseSchema.parse(response(changes)).changes.profile;
  for (const [key, value] of Object.entries(identity)) assert.equal(returned[key], value);
});

test('legacy backup profile IDs remain legal while all sync profile references require me', () => {
  const changes = { ...data(), profile: { ...profile, id: 'legacy-123' } };
  assert(backupDataSchema.safeParse(changes).success);
  assert(!syncEntitySchemas.profile.safeParse(changes.profile).success);
  assert(!syncRequestSchema.safeParse(request(changes)).success);
  assert(!syncResponseSchema.safeParse(response(changes)).success);
  for (const key of ['acknowledged', 'conflicts']) {
    assert(!syncResponseSchema.safeParse({ ...response({}), [key]: [{
      entityType: 'profile', entityId: 'legacy-123', reason: 'stale-version', serverVersion: 1,
    }] }).success);
  }
});

test('malformed records have consistent entity/backup/request/response rejection and field paths', () => {
  for (const [key, original, field, value] of [
    ['workoutTypes', type, 'category', 'cardio'], ['workoutTypes', type, 'id', '  '],
    ['logs', log, 'weight', '<img>'], ['logs', log, 'weight', Infinity],
    ['logs', log, 'reps', 0.5], ['logs', log, 'durationSeconds', 60],
    ['logs', log, 'date', '2026-02-30T12:00:00Z'], ['logs', log, 'version', Number.MAX_SAFE_INTEGER + 1],
    ['workouts', workout, 'status', 'unknown'], ['workouts', workout, 'endTime', '2025-01-01T00:00:00Z'],
    ['profile', profile, 'birthDate', '2026-02-30'], ['profile', profile, 'timeZone', '+03:00'],
  ]) {
    const entity = { ...original, [field]: value };
    const changes = { ...data(), [key]: key === 'profile' ? entity : [entity] };
    for (const parsed of [syncEntitySchemas[key].safeParse(entity), backupDataSchema.safeParse(changes),
      syncRequestSchema.safeParse(request(changes)), syncResponseSchema.safeParse(response(changes))]) {
      assert.equal(parsed.success, false, `${key}.${field}`);
      assert(parsed.error.issues.some(issue => issue.path.at(-1) === field), `${key}.${field}`);
    }
  }
});

test('duplicate IDs are rejected in each collection at every transport boundary', () => {
  for (const [key, entity] of Object.entries({ workoutTypes: type, logs: log, workouts: workout })) {
    const changes = { ...data(), [key]: [entity, entity] };
    for (const parsed of [backupDataSchema.safeParse(changes), syncRequestSchema.safeParse(request(changes)),
      syncResponseSchema.safeParse(response(changes))]) {
      assert.equal(parsed.success, false);
      assert.deepEqual(parsed.error.issues[0].path.slice(-3), [key, 1, 'id']);
    }
  }
});

test('strict request shape and permissive legacy response remain distinct', () => {
  assert(!syncRequestSchema.safeParse({ ...request({}), extra: true }).success);
  assert(!syncRequestSchema.safeParse(request({ unknown: [] })).success);
  assert(!syncRequestSchema.safeParse(request({ logs: [{ ...log, extra: true }] })).success);
  assert(syncResponseSchema.safeParse(response({ logs: [{ ...log, extra: true }] })).success);
  assert(syncRequestSchema.safeParse(request({ profile: null })).success);
  assert(syncResponseSchema.safeParse(response({ profile: null })).success);
  assert(syncResponseSchema.safeParse(response({})).success); // no protocol/ack/hasMore until S09
  assert(!syncResponseSchema.safeParse({ ...response({}), protocolVersion: 2 }).success);
  assert(!syncRequestSchema.safeParse({ ...request({}), protocolVersion: 2 }).success);
  assert(!syncRequestSchema.safeParse({ ...request({}), cursor: -1 }).success);
  assert(!syncRequestSchema.safeParse({ ...request({}), limit: 2001 }).success);
});

test('versioned backup requires workouts; legacy omitted-workout normalization stays in client adapter', () => {
  const envelope = { format: 'gym21-backup', version: 1, exportedAt: date, data: data() };
  assert(backupEnvelopeSchema.safeParse(envelope).success);
  assert(!backupEnvelopeSchema.safeParse({ ...envelope, version: 2 }).success);
  const { workouts: _workouts, ...missing } = data();
  assert(!backupEnvelopeSchema.safeParse({ ...envelope, data: missing }).success);
});

test('public read DTO requires neither local metadata nor historical workout link', () => {
  const parsed = publicProfileSchema.parse({
    displayName: 'Owner', identifier: 'owner', timeZone: 'UTC',
    stats: { totalWorkouts: 1, totalVolume: 0 }, recentActivity: [{ date: '2026-09-01', exerciseCount: 1 }],
    logs: [log], workoutTypes: [type], birthDate: '2000-01-01', telegramUserId: 123,
  });
  assert.equal(parsed.logs[0].workoutId, undefined);
  assert.equal(parsed.logs[0].updatedAt, undefined);
  assert.equal(Object.hasOwn(parsed, 'birthDate'), false);
  assert.equal(Object.hasOwn(parsed, 'telegramUserId'), false);
});

test('shared timezone primitives retain UTC fallback and owner day boundaries', () => {
  assert(validTimeZone('Europe/Moscow'));
  assert(!validTimeZone('+03:00'));
  assert.equal(accountTimeZone('bad-zone'), 'UTC');
  assert.equal(dayKey('2026-09-01T22:00:00Z', 'Europe/Moscow'), '2026-09-02');
  assert.equal(dayKey('invalid'), '');
});
