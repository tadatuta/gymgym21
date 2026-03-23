import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import request from 'supertest';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bucket-storage-test-'));
const storageDir = path.join(tempRoot, 'storage');

process.env.STORAGE_DIR = storageDir;
process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.AUTH_BASE_URL = 'http://localhost:8788/api/auth';
process.env.JSON_BODY_LIMIT = '2mb';
process.env.TELEGRAM_BOT_TOKEN = 'test_token';
process.env.BETTER_AUTH_SECRET = 'test-secret';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;

const [{ createApp }, { resolveRequestContext }, { findPublicProfileByIdentifier }, { Storage }, { HttpError }] = await Promise.all([
  import('../dist/app.js'),
  import('../dist/auth.js'),
  import('../dist/services/public-profile.js'),
  import('../dist/storage.js'),
  import('../dist/http/errors.js'),
]);

function createStubAuthHandler() {
  return async (req, res) => {
    if (req.url === '/api/auth/ok') {
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

function createTestApp(overrides = {}) {
  return createApp({
    authHandler: overrides.authHandler ?? createStubAuthHandler(),
    resolveRequestContext: overrides.resolveRequestContext ?? resolveRequestContext,
    generateRecommendation: overrides.generateRecommendation ?? (async () => '# Test recommendation'),
    findPublicProfile: overrides.findPublicProfile ?? findPublicProfileByIdentifier,
    readStorage: overrides.readStorage ?? Storage.read.bind(Storage),
    writeStorage: overrides.writeStorage ?? Storage.write.bind(Storage),
  });
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

beforeEach(async () => {
  await fs.rm(storageDir, { recursive: true, force: true });
  await Storage.ensureStorageDir();
});

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('GET /health returns service health', async () => {
  const app = createTestApp();
  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('OPTIONS applies CORS headers to protected routes', async () => {
  const app = createTestApp();
  const response = await request(app)
    .options('/api/me/storage')
    .set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'PUT');

  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.match(response.headers['access-control-allow-methods'], /PUT/);
});

test('GET /api/auth/ok is routed to the auth handler', async () => {
  const app = createTestApp();
  const response = await request(app).get('/api/auth/ok');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('GET /api/profiles/:identifier returns a public profile', async () => {
  await Storage.write('12345', {
    profile: {
      id: 'me',
      isPublic: true,
      showFullHistory: true,
      createdAt: new Date().toISOString(),
      displayName: 'Demo User',
      telegramUsername: 'demo_user',
    },
    logs: [
      {
        id: 'log-1',
        workoutTypeId: 'squat',
        duration: 15,
        durationSeconds: 30,
        date: '2026-03-20T10:00:00.000Z',
      },
    ],
    workoutTypes: [{ id: 'squat', name: 'Squat', category: 'time' }],
  });

  const app = createTestApp();
  const response = await request(app).get('/api/profiles/demo_user');

  assert.equal(response.status, 200);
  assert.equal(response.body.displayName, 'Demo User');
  assert.equal(response.body.identifier, 'demo_user');
  assert.equal(response.body.stats.favoriteExercise, 'Squat');
  assert.equal(response.body.logs[0].durationSeconds, 30);
  assert.equal(response.body.workoutTypes[0].category, 'time');
});

test('Telegram legacy auth can write and read storage data', async () => {
  const telegramUser = {
    id: 777,
    first_name: 'Telegram',
    username: 'telegram_user',
    photo_url: 'https://example.com/telegram-user.png',
  };
  const initData = generateInitData(telegramUser);
  const app = createTestApp();

  const writeResponse = await request(app)
    .put('/api/me/storage')
    .set('X-Telegram-Init-Data', initData)
    .send({
      workoutTypes: [
        {
          id: 'rower',
          name: 'Rower',
          category: 'time',
          updatedAt: '2026-03-20T10:00:00.000Z',
        },
      ],
      logs: [
        {
          id: 'log-1',
          workoutTypeId: 'rower',
          duration: 12,
          durationSeconds: 45,
          date: '2026-03-20T10:00:00.000Z',
          updatedAt: '2026-03-20T10:00:00.000Z',
        },
      ],
      workouts: [
        {
          id: 'workout-1',
          startTime: '2026-03-20T10:00:00.000Z',
          endTime: '2026-03-20T10:30:00.000Z',
          status: 'finished',
          isManual: true,
          pauseIntervals: [{ start: '2026-03-20T10:10:00.000Z', end: '2026-03-20T10:12:00.000Z' }],
          updatedAt: '2026-03-20T10:30:00.000Z',
        },
      ],
      profile: {
        id: 'me',
        isPublic: true,
        createdAt: '2026-03-20T10:00:00.000Z',
        displayName: 'Telegram Athlete',
      },
    });

  assert.equal(writeResponse.status, 200);

  const readResponse = await request(app)
    .get('/api/me/storage')
    .set('X-Telegram-Init-Data', initData);

  assert.equal(readResponse.status, 200);
  assert.equal(readResponse.body.profile.displayName, 'Telegram Athlete');
  assert.equal(readResponse.body.profile.telegramUserId, 777);
  assert.equal(readResponse.body.profile.telegramUsername, 'telegram_user');
  assert.equal(readResponse.body.profile.photoUrl, 'https://example.com/telegram-user.png');
  assert.equal(readResponse.body.logs[0].durationSeconds, 45);
  assert.equal(readResponse.body.workoutTypes[0].category, 'time');
  assert.equal(readResponse.body.workouts[0].pauseIntervals[0].end, '2026-03-20T10:12:00.000Z');
});

test('better-auth context enriches saved profile with canonical username and image', async () => {
  const app = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'better-auth',
      storageKey: 'u_user-1',
      authUser: {
        id: 'user-1',
        name: 'User 1',
        email: 'user1@example.com',
        emailVerified: true,
        image: 'https://example.com/avatar.png',
        createdAt: new Date('2026-03-20T10:00:00.000Z'),
        updatedAt: new Date('2026-03-20T10:00:00.000Z'),
        username: 'canonical_user',
        displayUsername: 'canonical_user',
        migrationCompleted: true,
      },
    }),
  });

  const response = await request(app)
    .put('/api/me/storage')
    .send({
      profile: {
        id: 'me',
        isPublic: false,
        createdAt: '2026-03-20T10:00:00.000Z',
        displayName: 'Auth User',
      },
    });

  assert.equal(response.status, 200);

  const stored = await Storage.read('u_user-1');
  assert.equal(stored.profile?.username, 'canonical_user');
  assert.equal(stored.profile?.photoUrl, 'https://example.com/avatar.png');
});

test('POST /api/me/ai/recommendations uses stored workout data and returns HTML', async () => {
  await Storage.write('ai-user', {
    profile: {
      id: 'me',
      isPublic: false,
      createdAt: '2026-03-20T10:00:00.000Z',
      displayName: 'AI User',
    },
    logs: [
      {
        id: 'log-1',
        workoutTypeId: 'bench',
        reps: 8,
        weight: 80,
        date: '2026-03-21T10:00:00.000Z',
      },
    ],
    workoutTypes: [{ id: 'bench', name: 'Bench Press' }],
  });

  let capturedRequest;
  const app = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'telegram-legacy',
      storageKey: 'ai-user',
      telegramUser: {
        id: 888,
        first_name: 'AI',
      },
    }),
    generateRecommendation: async (input) => {
      capturedRequest = input;
      return '# Weekly plan';
    },
  });

  const response = await request(app)
    .post('/api/me/ai/recommendations')
    .send({ type: 'plan', options: { period: 'week' } });

  assert.equal(response.status, 200);
  assert.match(response.body.recommendation, /<h1[^>]*>Weekly plan<\/h1>/);
  assert.equal(capturedRequest.type, 'plan');
  assert.equal(capturedRequest.profile.displayName, 'AI User');
  assert.equal(capturedRequest.logs.length, 1);
});

test('POST /api/me/ai/recommendations returns explicit config error when AI dependency is unavailable', async () => {
  await Storage.write('ai-config-user', {
    profile: {
      id: 'me',
      isPublic: false,
      createdAt: '2026-03-20T10:00:00.000Z',
      displayName: 'AI Config User',
    },
  });

  const app = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'telegram-legacy',
      storageKey: 'ai-config-user',
      telegramUser: {
        id: 889,
        first_name: 'AI',
      },
    }),
    generateRecommendation: async () => {
      throw new HttpError(503, 'AI is not configured', {
        code: 'AI_NOT_CONFIGURED',
      });
    },
  });

  const response = await request(app)
    .post('/api/me/ai/recommendations')
    .send({ type: 'general' });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'AI is not configured');
  assert.equal(response.body.code, 'AI_NOT_CONFIGURED');
});

test('PUT /api/me/storage accepts payloads above the old 100kb default body limit', async () => {
  const logs = Array.from({ length: 2500 }, (_, index) => ({
    id: `log-${index}`,
    workoutTypeId: 'run',
    duration: 30,
    date: '2026-03-22T10:00:00.000Z',
  }));

  const app = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'telegram-legacy',
      storageKey: 'big-payload-user',
      telegramUser: {
        id: 999,
        first_name: 'Big',
      },
    }),
  });

  const response = await request(app)
    .put('/api/me/storage')
    .send({ logs });

  assert.equal(response.status, 200);

  const stored = await Storage.read('big-payload-user');
  assert.equal(stored.logs?.length, 2500);
});

test('PUT /api/me/storage rejects invalid display names', async () => {
  const app = createTestApp({
    resolveRequestContext: async () => ({
      kind: 'telegram-legacy',
      storageKey: 'invalid-user',
      telegramUser: {
        id: 1000,
        first_name: 'Invalid',
      },
    }),
  });

  const response = await request(app)
    .put('/api/me/storage')
    .send({
      profile: {
        id: 'me',
        isPublic: false,
        createdAt: '2026-03-20T10:00:00.000Z',
        displayName: 'x'.repeat(101),
      },
    });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Display name too long');
});
