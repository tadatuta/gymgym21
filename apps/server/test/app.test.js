import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import request from 'supertest';

process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.AUTH_BASE_URL = 'http://localhost:8788/api/auth';
process.env.JSON_BODY_LIMIT = '2mb';
process.env.TELEGRAM_BOT_TOKEN = 'test_token';
process.env.BETTER_AUTH_SECRET = 'test-secret';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;

const [{ createApp }, { HttpError }] = await Promise.all([
  import('../dist/app.js'),
  import('../dist/http/errors.js'),
]);
const { config } = await import('../dist/config.js');

const defaultGuardrailConfig = {
  RATE_LIMITS_ENABLED: config.RATE_LIMITS_ENABLED,
  RATE_LIMIT_AUTH_WINDOW_MS: config.RATE_LIMIT_AUTH_WINDOW_MS,
  RATE_LIMIT_AUTH_MAX: config.RATE_LIMIT_AUTH_MAX,
  RATE_LIMIT_AUTH_USERNAME_CHECK_WINDOW_MS: config.RATE_LIMIT_AUTH_USERNAME_CHECK_WINDOW_MS,
  RATE_LIMIT_AUTH_USERNAME_CHECK_MAX: config.RATE_LIMIT_AUTH_USERNAME_CHECK_MAX,
  RATE_LIMIT_STORAGE_WINDOW_MS: config.RATE_LIMIT_STORAGE_WINDOW_MS,
  RATE_LIMIT_STORAGE_MAX: config.RATE_LIMIT_STORAGE_MAX,
  RATE_LIMIT_SYNC_WINDOW_MS: config.RATE_LIMIT_SYNC_WINDOW_MS,
  RATE_LIMIT_SYNC_MAX: config.RATE_LIMIT_SYNC_MAX,
  RATE_LIMIT_SYNC_MAX_CONCURRENT: config.RATE_LIMIT_SYNC_MAX_CONCURRENT,
  RATE_LIMIT_AI_WINDOW_MS: config.RATE_LIMIT_AI_WINDOW_MS,
  RATE_LIMIT_AI_MAX: config.RATE_LIMIT_AI_MAX,
  RATE_LIMIT_AI_MAX_CONCURRENT: config.RATE_LIMIT_AI_MAX_CONCURRENT,
};

function resetGuardrailConfig() {
  Object.assign(config, defaultGuardrailConfig);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStubAuthHandler() {
  return async (req, res) => {
    if (
      req.url === '/api/auth/ok'
      || req.url === '/api/auth/register/email'
      || req.url === '/api/auth/migration/complete'
      || req.url === '/api/auth/username/check'
      || req.url === '/api/auth/telegram/sign-in'
    ) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

function normalizeAlias(value) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function buildPublicProfile(snapshot, fallbackIdentifier) {
  const profile = snapshot.profile;
  if (!profile || profile.isDeleted || !profile.isPublic) {
    return null;
  }

  const workoutTypes = (snapshot.workoutTypes ?? []).filter((entry) => !entry.isDeleted);
  const visibleTypeIds = new Set(workoutTypes.map((entry) => entry.id));
  const logs = (snapshot.logs ?? []).filter((entry) => !entry.isDeleted && visibleTypeIds.has(entry.workoutTypeId));

  const totalVolume = logs.reduce((sum, entry) => sum + ((entry.weight ?? 0) * (entry.reps ?? 0)), 0);
  const counts = new Map();
  for (const log of logs) {
    counts.set(log.workoutTypeId, (counts.get(log.workoutTypeId) ?? 0) + 1);
  }

  const favoriteId = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const favoriteExercise = favoriteId ? workoutTypes.find((entry) => entry.id === favoriteId)?.name : undefined;
  const activityMap = new Map();
  for (const log of logs) {
    const day = log.date.slice(0, 10);
    activityMap.set(day, (activityMap.get(day) ?? 0) + 1);
  }

  return {
    displayName: profile.displayName || profile.username || profile.telegramUsername || fallbackIdentifier,
    identifier: profile.username || profile.telegramUsername || fallbackIdentifier,
    photoUrl: profile.photoUrl,
    stats: {
      totalWorkouts: logs.length,
      totalVolume,
      favoriteExercise,
      lastWorkoutDate: logs.length ? [...logs].sort((left, right) => left.date.localeCompare(right.date)).at(-1).date : undefined,
    },
    recentActivity: [...activityMap.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, exerciseCount]) => ({ date, exerciseCount })),
    ...(profile.showFullHistory ? { logs, workoutTypes } : {}),
  };
}

function createMemoryStorageRepository() {
  const snapshots = new Map();

  function ensureSnapshot(storageKey) {
    if (!snapshots.has(storageKey)) {
      snapshots.set(storageKey, {
        cursor: 0,
        workoutTypes: [],
        logs: [],
        workouts: [],
        profile: undefined,
      });
    }

    return snapshots.get(storageKey);
  }

  function bumpEntity(snapshot, entity) {
    snapshot.cursor += 1;
    return {
      ...clone(entity),
      updatedAt: entity.updatedAt ?? new Date().toISOString(),
      version: snapshot.cursor,
      serverUpdatedAt: new Date().toISOString(),
    };
  }

  function applyEntity(snapshot, collectionName, entity) {
    const collection = snapshot[collectionName];
    const index = collection.findIndex((entry) => entry.id === entity.id);
    if (index >= 0) {
      collection[index] = entity;
    } else {
      collection.push(entity);
    }
  }

  function listAliases(storageKey, snapshot) {
    const aliases = new Set([`id_${storageKey}`.toLowerCase()]);
    if (snapshot.profile?.username) {
      aliases.add(normalizeAlias(snapshot.profile.username));
    }
    if (snapshot.profile?.telegramUsername) {
      aliases.add(normalizeAlias(snapshot.profile.telegramUsername));
    }
    return aliases;
  }

  return {
    async readSnapshot(storageKey) {
      const snapshot = ensureSnapshot(String(storageKey));
      return {
        revision: snapshot.cursor,
        workoutTypes: clone(snapshot.workoutTypes),
        logs: clone(snapshot.logs),
        workouts: clone(snapshot.workouts),
        profile: snapshot.profile ? clone(snapshot.profile) : undefined,
      };
    },

    async replaceSnapshot(storageKey, data) {
      snapshots.set(String(storageKey), {
        cursor: Number(data.revision ?? 0),
        workoutTypes: clone(data.workoutTypes ?? []),
        logs: clone(data.logs ?? []),
        workouts: clone(data.workouts ?? []),
        profile: data.profile ? clone(data.profile) : undefined,
      });
    },

    async sync(storageKey, requestPayload, authContext) {
      const snapshot = ensureSnapshot(String(storageKey));
      const conflicts = [];
      const authoritative = {
        workoutTypes: [],
        logs: [],
        workouts: [],
        profile: null,
      };

      const applyCollection = (collectionName, incomingItems = []) => {
        for (const incoming of incomingItems) {
          const collection = snapshot[collectionName];
          const existing = collection.find((entry) => entry.id === incoming.id);
          if (existing && (incoming.version ?? 0) !== (existing.version ?? 0)) {
            conflicts.push({
              entityType: collectionName,
              entityId: incoming.id,
              reason: 'stale-version',
              serverVersion: existing.version ?? 0,
            });
            authoritative[collectionName].push(clone(existing));
            continue;
          }

          if (!existing && incoming.isDeleted) {
            continue;
          }

          applyEntity(snapshot, collectionName, bumpEntity(snapshot, incoming));
        }
      };

      applyCollection('workoutTypes', requestPayload.changes.workoutTypes ?? []);
      applyCollection('logs', requestPayload.changes.logs ?? []);
      applyCollection('workouts', requestPayload.changes.workouts ?? []);

      if (requestPayload.changes.profile) {
        const incoming = clone(requestPayload.changes.profile);
        const existing = snapshot.profile;
        if (existing && (incoming.version ?? 0) !== (existing.version ?? 0)) {
          conflicts.push({
            entityType: 'profile',
            entityId: existing.id,
            reason: 'stale-version',
            serverVersion: existing.version ?? 0,
          });
          authoritative.profile = clone(existing);
        } else {
          snapshot.profile = bumpEntity(snapshot, {
            ...incoming,
            id: incoming.id || 'me',
            isPublic: incoming.isPublic ?? false,
            createdAt: incoming.createdAt ?? new Date().toISOString(),
            updatedAt: incoming.updatedAt ?? new Date().toISOString(),
            friends: incoming.friends ?? [],
            username: authContext.authUser?.username ?? incoming.username,
            telegramUsername: authContext.telegramUser?.username ?? incoming.telegramUsername,
          });
        }
      }

      const changes = {
        workoutTypes: snapshot.workoutTypes.filter((entry) => (entry.version ?? 0) > requestPayload.cursor),
        logs: snapshot.logs.filter((entry) => (entry.version ?? 0) > requestPayload.cursor),
        workouts: snapshot.workouts.filter((entry) => (entry.version ?? 0) > requestPayload.cursor),
        profile: snapshot.profile && (snapshot.profile.version ?? 0) > requestPayload.cursor ? clone(snapshot.profile) : null,
      };

      for (const entity of authoritative.workoutTypes) {
        if (!changes.workoutTypes.some((entry) => entry.id === entity.id)) {
          changes.workoutTypes.push(entity);
        }
      }
      for (const entity of authoritative.logs) {
        if (!changes.logs.some((entry) => entry.id === entity.id)) {
          changes.logs.push(entity);
        }
      }
      for (const entity of authoritative.workouts) {
        if (!changes.workouts.some((entry) => entry.id === entity.id)) {
          changes.workouts.push(entity);
        }
      }
      if (authoritative.profile && !changes.profile) {
        changes.profile = authoritative.profile;
      }

      return {
        cursor: snapshot.cursor,
        changes,
        conflicts,
      };
    },

    async updateProfileFromAuth(storageKey, data) {
      const snapshot = ensureSnapshot(String(storageKey));
      snapshot.cursor += 1;
      snapshot.profile = {
        ...(snapshot.profile ?? {
          id: 'me',
          isPublic: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          friends: [],
        }),
        ...(data.username ? { username: data.username } : {}),
        ...(!snapshot.profile?.displayName && data.name ? { displayName: data.name } : {}),
        ...(data.image ? { photoUrl: data.image } : {}),
        ...(data.telegramUser
          ? {
              telegramUserId: data.telegramUser.id,
              telegramUsername: data.telegramUser.username,
              photoUrl: data.telegramUser.photo_url ?? data.image ?? snapshot.profile?.photoUrl,
            }
          : {}),
        updatedAt: new Date().toISOString(),
        version: snapshot.cursor,
        serverUpdatedAt: new Date().toISOString(),
      };
    },

    async readAiContext(storageKey) {
      const snapshot = ensureSnapshot(String(storageKey));
      return {
        profile: snapshot.profile ? clone(snapshot.profile) : undefined,
        workoutTypes: clone(snapshot.workoutTypes.filter((entry) => !entry.isDeleted)),
        workouts: clone(snapshot.workouts.filter((entry) => !entry.isDeleted)),
        logs: clone(snapshot.logs.filter((entry) => !entry.isDeleted)),
      };
    },

    async findPublicProfileByIdentifier(identifier) {
      const normalized = normalizeAlias(identifier);
      for (const [storageKey, snapshot] of snapshots.entries()) {
        if (!listAliases(storageKey, snapshot).has(normalized)) {
          continue;
        }
        return buildPublicProfile(snapshot, identifier);
      }
      return null;
    },

    async getPublicProfileByStorageKey(storageKey, fallbackIdentifier = `id_${storageKey}`) {
      return buildPublicProfile(ensureSnapshot(String(storageKey)), fallbackIdentifier);
    },
  };
}

function createTestApp(overrides = {}) {
  const storageRepository = overrides.storageRepository ?? createMemoryStorageRepository();
  return {
    app: createApp({
      authHandler: overrides.authHandler ?? createStubAuthHandler(),
      resolveRequestContext: overrides.resolveRequestContext ?? (async () => ({
        kind: 'telegram',
        storageKey: 'test-user',
        telegramUser: { id: 123, first_name: 'Test', username: 'test_user' },
      })),
      generateRecommendation: overrides.generateRecommendation ?? (async () => '# Test recommendation'),
      findPublicProfile: overrides.findPublicProfile ?? ((identifier) => storageRepository.findPublicProfileByIdentifier(identifier)),
      storageRepository,
    }),
    storageRepository,
  };
}

function generateInitData(user) {
  const data = {
    user: JSON.stringify(user),
    auth_date: Math.floor(Date.now() / 1000).toString(),
  };

  const dataCheckString = Object.entries(data)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData')
    .update('test_token')
    .digest();

  const hash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return `${new URLSearchParams(data).toString()}&hash=${hash}`;
}

beforeEach(() => {
  resetGuardrailConfig();
});

afterEach(() => {
  resetGuardrailConfig();
});

test('GET /health returns service health', async () => {
  const { app } = createTestApp();
  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('OPTIONS applies CORS headers to the sync route', async () => {
  const { app } = createTestApp();
  const response = await request(app)
    .options('/api/me/storage/sync')
    .set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'POST');

  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.match(response.headers['access-control-allow-methods'], /POST/);
});

test('GET /api/auth/ok is routed to the auth handler', async () => {
  const { app } = createTestApp();
  const response = await request(app).get('/api/auth/ok');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('POST /api/auth/register/email is rate limited after repeated attempts', async () => {
  config.RATE_LIMIT_AUTH_MAX = 2;
  config.RATE_LIMIT_AUTH_WINDOW_MS = 60_000;

  const { app } = createTestApp();

  const first = await request(app).post('/api/auth/register/email').send({ email: 'one@example.com' });
  const second = await request(app).post('/api/auth/register/email').send({ email: 'two@example.com' });
  const third = await request(app).post('/api/auth/register/email').send({ email: 'three@example.com' });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'RATE_LIMIT_EXCEEDED');
});

test('GET /api/profiles/:identifier returns a public profile from the read model', async () => {
  const { app, storageRepository } = createTestApp();
  await storageRepository.replaceSnapshot('12345', {
    workoutTypes: [{ id: 'squat', name: 'Squat', category: 'time', updatedAt: '2026-03-20T10:00:00.000Z' }],
    logs: [{
      id: 'log-1',
      workoutTypeId: 'squat',
      duration: 15,
      durationSeconds: 30,
      date: '2026-03-20T10:00:00.000Z',
      updatedAt: '2026-03-20T10:00:00.000Z',
    }],
    workouts: [],
    profile: {
      id: 'me',
      isPublic: true,
      showFullHistory: true,
      createdAt: '2026-03-20T10:00:00.000Z',
      updatedAt: '2026-03-20T10:00:00.000Z',
      displayName: 'Demo User',
      telegramUsername: 'demo_user',
    },
  });

  const response = await request(app).get('/api/profiles/demo_user');

  assert.equal(response.status, 200);
  assert.equal(response.body.displayName, 'Demo User');
  assert.equal(response.body.identifier, 'demo_user');
  assert.equal(response.body.stats.favoriteExercise, 'Squat');
  assert.equal(response.body.logs[0].durationSeconds, 30);
});

test('GET and PUT snapshot endpoints are removed from runtime', async () => {
  const { app } = createTestApp();

  const getResponse = await request(app).get('/api/me/storage');
  const putResponse = await request(app).put('/api/me/storage').send({});

  assert.equal(getResponse.status, 404);
  assert.equal(putResponse.status, 404);
});

test('POST /api/me/storage/sync writes delta records and returns cursor metadata', async () => {
  const { app, storageRepository } = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'telegram',
      storageKey: 'sync-user',
      telegramUser: { id: 321, first_name: 'Sync', username: 'sync_user' },
    }),
  });

  const response = await request(app)
    .post('/api/me/storage/sync')
    .send({
      cursor: 0,
      changes: {
        workoutTypes: [
          {
            id: 'bench',
            name: 'Bench Press',
            updatedAt: '2026-03-01T12:00:00.000Z',
          },
        ],
      },
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.cursor, 1);
  assert.equal(response.body.changes.workoutTypes[0].version, 1);

  const stored = await storageRepository.readSnapshot('sync-user');
  assert.equal(stored.revision, 1);
  assert.equal(stored.workoutTypes[0].id, 'bench');
});

test('POST /api/me/storage/sync returns authoritative entities on stale updates', async () => {
  const { app } = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'telegram',
      storageKey: 'conflict-user',
      telegramUser: { id: 654, first_name: 'Conflict', username: 'conflict_user' },
    }),
  });

  const initial = await request(app)
    .post('/api/me/storage/sync')
    .send({
      cursor: 0,
      changes: {
        workoutTypes: [{ id: 'bench', name: 'Bench Press', updatedAt: '2026-03-01T10:00:00.000Z' }],
      },
    });

  const accepted = await request(app)
    .post('/api/me/storage/sync')
    .send({
      cursor: initial.body.cursor,
      changes: {
        workoutTypes: [{
          id: 'bench',
          name: 'Bench Press Wide Grip',
          updatedAt: '2026-03-01T11:00:00.000Z',
          version: initial.body.changes.workoutTypes[0].version,
        }],
      },
    });

  const stale = await request(app)
    .post('/api/me/storage/sync')
    .send({
      cursor: initial.body.cursor,
      changes: {
        workoutTypes: [{
          id: 'bench',
          name: 'Stale Name',
          updatedAt: '2026-03-01T12:00:00.000Z',
          version: initial.body.changes.workoutTypes[0].version,
        }],
      },
    });

  assert.equal(accepted.status, 200);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.conflicts.length, 1);
  assert.equal(stale.body.conflicts[0].reason, 'stale-version');
  assert.equal(stale.body.changes.workoutTypes[0].name, 'Bench Press Wide Grip');
});

test('POST /api/me/storage/sync propagates soft deletions incrementally', async () => {
  const { app } = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'telegram',
      storageKey: 'deletion-user',
      telegramUser: { id: 777, first_name: 'Delete', username: 'delete_user' },
    }),
  });

  const created = await request(app)
    .post('/api/me/storage/sync')
    .send({
      cursor: 0,
      changes: {
        logs: [{
          id: 'log-1',
          workoutTypeId: 'bench',
          workoutId: 'workout-1',
          reps: 5,
          weight: 100,
          date: '2026-03-05T12:00:00.000Z',
          updatedAt: '2026-03-05T12:00:00.000Z',
        }],
      },
    });

  const deletion = await request(app)
    .post('/api/me/storage/sync')
    .send({
      cursor: created.body.cursor,
      changes: {
        logs: [{
          id: 'log-1',
          workoutTypeId: 'bench',
          workoutId: 'workout-1',
          reps: 5,
          weight: 100,
          date: '2026-03-05T12:00:00.000Z',
          updatedAt: '2026-03-05T12:30:00.000Z',
          isDeleted: true,
          version: created.body.changes.logs[0].version,
        }],
      },
    });

  const bootstrap = await request(app)
    .post('/api/me/storage/sync')
    .send({
      cursor: 0,
      changes: {},
    });

  assert.equal(deletion.status, 200);
  assert.equal(deletion.body.changes.logs[0].isDeleted, true);
  assert.equal(bootstrap.body.changes.logs.length, 1);
  assert.equal(bootstrap.body.changes.logs[0].isDeleted, true);
});

test('POST /api/me/ai/recommendations reads AI context from the repository', async () => {
  let receivedPayload;
  const { app, storageRepository } = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'telegram',
      storageKey: 'ai-user',
      telegramUser: { id: 888, first_name: 'AI', username: 'ai_user' },
    }),
    generateRecommendation: async (payload) => {
      receivedPayload = payload;
      return '# Recommendation';
    },
  });

  await storageRepository.replaceSnapshot('ai-user', {
    workoutTypes: [{ id: 'bench', name: 'Bench Press', updatedAt: '2026-03-01T10:00:00.000Z' }],
    logs: [{
      id: 'log-1',
      workoutTypeId: 'bench',
      workoutId: 'workout-1',
      reps: 5,
      weight: 100,
      date: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-01T10:00:00.000Z',
    }],
    workouts: [],
    profile: {
      id: 'me',
      isPublic: false,
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-01T10:00:00.000Z',
      displayName: 'AI User',
    },
  });

  const response = await request(app)
    .post('/api/me/ai/recommendations')
    .send({
      type: 'general',
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.format, 'markdown');
  assert.equal(response.body.recommendation, '# Recommendation');
  assert.equal(receivedPayload.logs.length, 1);
  assert.equal(receivedPayload.workoutTypes.length, 1);
});

test('unauthorized requests to protected routes return 401', async () => {
  const { app } = createTestApp({
    resolveRequestContext: async () => null,
  });

  const response = await request(app).post('/api/me/storage/sync').send({ cursor: 0, changes: {} });

  assert.equal(response.status, 401);
});

test('Telegram Mini App auth headers can still be transformed into a request context by a custom resolver', async () => {
  const initData = generateInitData({
    id: 999,
    first_name: 'Mini',
    username: 'mini_user',
  });

  const { app } = createTestApp({
    resolveRequestContext: async (headers) => {
      const header = headers.get('x-telegram-init-data');
      if (!header || header !== initData) {
        return null;
      }

      return {
        kind: 'telegram',
        storageKey: 'mini-user',
        telegramUser: { id: 999, first_name: 'Mini', username: 'mini_user' },
      };
    },
  });

  const response = await request(app)
    .post('/api/me/storage/sync')
    .set('x-telegram-init-data', initData)
    .send({ cursor: 0, changes: {} });

  assert.equal(response.status, 200);
});
