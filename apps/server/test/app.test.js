import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const { createApp } = await import('../dist/app.js');
const fixtures = JSON.parse(readFileSync(new URL('../../../test/fixtures/contracts.json', import.meta.url), 'utf8'));
const { syncResponseSchema } = await import('@gym21/contracts');
const { createMemoryRateLimitStore } = await import('../dist/http/middleware/rate-limit-store.js');
const { config } = await import('../dist/config.js');

const defaultGuardrailConfig = {
  RATE_LIMITS_ENABLED: config.RATE_LIMITS_ENABLED,
  RATE_LIMIT_AUTH_WINDOW_MS: config.RATE_LIMIT_AUTH_WINDOW_MS,
  RATE_LIMIT_PUBLIC_MAX: config.RATE_LIMIT_PUBLIC_MAX,
  RATE_LIMIT_PUBLIC_MAX_CONCURRENT: config.RATE_LIMIT_PUBLIC_MAX_CONCURRENT,
  RATE_LIMIT_AUTH_MAX: config.RATE_LIMIT_AUTH_MAX,
  RATE_LIMIT_AUTH_USERNAME_CHECK_WINDOW_MS: config.RATE_LIMIT_AUTH_USERNAME_CHECK_WINDOW_MS,
  RATE_LIMIT_AUTH_USERNAME_CHECK_MAX: config.RATE_LIMIT_AUTH_USERNAME_CHECK_MAX,
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

// HTTP dependency seam only: no alias, revision, conflict, or statistics algorithms.
function createPresetRepository(presets = {}) {
  const calls = [];
  return new Proxy({ calls }, {
    get(target, method) {
      if (method === 'calls') return calls;
      return async (...args) => {
        calls.push({ method, args });
        if (!Object.hasOwn(presets, method)) throw new Error(`Unconfigured repository call: ${String(method)}`);
        return structuredClone(presets[method]);
      };
    },
  });
}

function createTestApp(overrides = {}) {
  const storageRepository = overrides.storageRepository ?? createPresetRepository();
  return {
    app: createApp({
      rateLimitStore: createMemoryRateLimitStore(),
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
  assert.match(response.headers['access-control-allow-headers'], /X-Expected-Storage-Key/i);
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

test('passkey challenges and password mutations share the strict budget, session reads stay available', async () => {
  config.RATE_LIMIT_AUTH_MAX = 1;
  const { app } = createTestApp({ authHandler: async (_req, res) => { res.end('{}'); } });
  await request(app).get('/api/auth/passkey/generate-authenticate-options').expect(200);
  await request(app).post('/api/auth/sign-in/email').send({}).expect(429);
  await request(app).get('/api/auth/passkey/generate-register-options').expect(429);
  await request(app).get('/api/auth/get-session').expect(200);
});

test('GET /api/profiles/:identifier returns a public profile from the read model', async () => {
  const storageRepository = createPresetRepository({ findPublicProfileByIdentifier: fixtures.publicProfile });
  const { app } = createTestApp({ storageRepository });

  const response = await request(app).get('/api/profiles/demo_user');

  assert.equal(response.status, 200);
  assert.equal(response.body.displayName, 'Demo User');
  assert.equal(response.body.identifier, 'demo_user');
  assert.equal(response.body.stats.favoriteExercise, 'Squat');
  assert.deepEqual(response.body, fixtures.publicProfile);
  assert.equal(storageRepository.calls[0].args[0], 'demo_user');
});

test('GET and PUT snapshot endpoints are removed from runtime', async () => {
  const { app } = createTestApp();

  const getResponse = await request(app).get('/api/me/storage').set('X-Expected-Storage-Key', 'test-user');
  const putResponse = await request(app).put('/api/me/storage').set('X-Expected-Storage-Key', 'test-user').send({});

  assert.equal(getResponse.status, 404);
  assert.equal(putResponse.status, 404);
});

for (const fixture of fixtures.validRequests) {
  test(`sync HTTP forwards shared request: ${fixture.name}`, async () => {
    const dto = fixtures.validResponses[1].value;
    const storageRepository = createPresetRepository({ sync: dto });
    const { app } = createTestApp({ storageRepository });
    const response = await request(app).post('/api/me/storage/sync')
      .set('X-Expected-Storage-Key', 'test-user').send(fixture.value);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, dto);
    assert.equal(syncResponseSchema.safeParse(response.body).success, true);
    assert.equal(storageRepository.calls.length, 1);
    assert.equal(storageRepository.calls[0].args[0], 'test-user');
    assert.deepEqual(storageRepository.calls[0].args[1], fixture.value);
    assert.equal(storageRepository.calls[0].args[2].telegramUser.id, 123);
  });
}
for (const fixture of fixtures.invalidRequests) {
  test(`sync HTTP rejects shared request before repository: ${fixture.name}`, async () => {
    const { app, storageRepository } = createTestApp();
    const response = await request(app).post('/api/me/storage/sync')
      .set('X-Expected-Storage-Key', 'test-user').send(fixture.value);
    assert.equal(response.status, fixture.status);
    assert.deepEqual(storageRepository.calls, []);
  });
}
for (const fixture of [...fixtures.validResponses, ...fixtures.invalidResponses]) {
  test(`server response contract: ${fixture.name}`, () => {
    assert.equal(syncResponseSchema.safeParse(fixture.value).success, fixtures.validResponses.includes(fixture));
  });
}

test('POST /api/me/ai/recommendations reads AI context from the repository', async () => {
  let receivedPayload;
  const context = {
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
  };

  const storageRepository = createPresetRepository({ readAiContext: context });
  const { app } = createTestApp({
    storageRepository,
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

  const response = await request(app)
    .post('/api/me/ai/recommendations').set('X-Expected-Storage-Key', 'ai-user')
    .send({
      type: 'general', expectedRevision: 0,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.format, 'markdown');
  assert.equal(response.body.recommendation, '# Recommendation');
  assert.deepEqual(storageRepository.calls, [{ method: 'readAiContext', args: ['ai-user', 0] }]);
  assert.deepEqual(receivedPayload, { type: 'general', expectedRevision: 0, ...context });
  assert.equal(receivedPayload.logs.length, 1);
  assert.equal(receivedPayload.workoutTypes.length, 1);
});

test('unauthorized requests to protected routes return 401', async () => {
  const { app } = createTestApp({
    resolveRequestContext: async () => null,
  });

  const response = await request(app).post('/api/me/storage/sync').set('X-Expected-Storage-Key', 'test-user').send({ protocolVersion: 1, cursor: 0, changes: {} });

  assert.equal(response.status, 401);
});

test('Telegram Mini App auth headers can still be transformed into a request context by a custom resolver', async () => {
  // Header forwarding only; cryptographic verification is covered by real auth tests.
  const initData = 'synthetic-custom-resolver-header';

  const { app } = createTestApp({
    storageRepository: createPresetRepository({ sync: fixtures.validResponses[0].value }),
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
    .post('/api/me/storage/sync').set('X-Expected-Storage-Key', 'mini-user')
    .set('x-telegram-init-data', initData)
    .send({ protocolVersion: 1, cursor: 0, changes: {} });

  assert.equal(response.status, 200);
});

test('AI timeout aborts transport but holds concurrency until the underlying promise settles', async () => {
  const previous = config.AI_TIMEOUT_MS;
  config.AI_TIMEOUT_MS = 30;
  config.RATE_LIMIT_AI_MAX = 100;
  let finish;
  let signal;
  let calls = 0;
  const { app } = createTestApp({ storageRepository: createPresetRepository({ readAiContext: { logs: [], workoutTypes: [], workouts: [] } }), generateRecommendation: async (_payload, value) => {
    signal = value;
    calls++;
    if (calls > 1) return 'retry succeeded';
    return new Promise(resolve => { finish = resolve; });
  } });
  const send = () => request(app).post('/api/me/ai/recommendations').set('X-Expected-Storage-Key', 'test-user').send({ type: 'general', expectedRevision: 0 });
  try {
    const first = await send();
    assert.equal(first.status, 503);
    assert.equal(first.body.code, 'AI_TIMEOUT');
    assert.equal(signal.aborted, true);
    const blocked = await send();
    assert.equal(blocked.body.code, 'ROUTE_BUSY');
    assert.equal(calls, 1);
    finish('late response');
    await new Promise(resolve => setImmediate(resolve));
    const retry = await send();
    assert.equal(retry.status, 200);
    assert.equal(calls, 2);
  } finally { finish?.('cleanup'); config.AI_TIMEOUT_MS = previous; }
});

test('AI disconnect aborts transport and retains busy slot for ignored cancellation', async () => {
  config.RATE_LIMIT_AI_MAX = 100;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let finish;
  let signal;
  const { app } = createTestApp({ storageRepository: createPresetRepository({ readAiContext: { logs: [], workoutTypes: [], workouts: [] } }), generateRecommendation: async (_payload, value) => {
    signal = value;
    started();
    return new Promise(resolve => { finish = resolve; });
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/me/ai/recommendations`;
  const controller = new AbortController();
  try {
    const pending = fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Expected-Storage-Key': 'test-user' }, body: JSON.stringify({ type: 'general', expectedRevision: 0 }), signal: controller.signal });
    const rejected = assert.rejects(pending);
    await ready;
    controller.abort();
    await rejected;
    for (let i = 0; i < 100 && !signal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.code, 'AI_CANCELLED');
    const blocked = await request(server).post('/api/me/ai/recommendations').set('X-Expected-Storage-Key', 'test-user').send({ type: 'general', expectedRevision: 0 });
    assert.equal(blocked.body.code, 'ROUTE_BUSY');
  } finally { finish?.('cleanup'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});


test('public profile requests are IP bounded and validate cursor query shape', async () => {
  config.RATE_LIMIT_PUBLIC_MAX = 2;
  const { app } = createTestApp();
  assert.equal((await request(app).get('/api/profiles/missing?cursor=a&cursor=b')).status, 400);
  assert.equal((await request(app).get('/api/profiles/missing?cursor=')).status, 400);
  const limited = await request(app).get('/api/profiles/missing');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMIT_EXCEEDED');
  assert.ok(Number(limited.headers['retry-after']) > 0);
});
