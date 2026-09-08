// T04: actual client auth module + SDK + mounted production auth + PostgreSQL.
// Only the first two sign-out responses are fault-injected; no fake auth/session implementation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createServer } from 'vite';
import '../apps/server/scripts/require-test-database.mjs';

// The CLI preflight sets exitCode; an imported caller must stop explicitly.
if (process.exitCode) throw new Error('Auth browser fixture stopped: PostgreSQL preflight failed.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const schema = `auth_browser_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.GYM21_TEST_DATABASE_URL });
const envDir = await mkdtemp(join(tmpdir(), 'gym21-auth-browser-'));
let server;
let browser;
let closeAuthResources;
let closeDatabasePool;
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.GYM21_TEST_DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  delete process.env.DATABASE_SSL;
  process.env.BETTER_AUTH_SECRET = 'browser-auth-fixture-secret-at-least-32-characters';
  process.env.TELEGRAM_BOT_TOKEN = 'browser-auth-synthetic-token';
  process.env.RATE_LIMITS_ENABLED = 'false';
  let app;
  server = await createServer({ root: resolve('apps/client'), configFile: false, envDir,
    define: { 'import.meta.env.VITE_AUTH_BASE_URL': JSON.stringify('/api/auth'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { entries: [], include: ['dexie', 'better-auth/client', '@better-auth/passkey/client'] },
    plugins: [{ name: 'real-auth-fixture', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/')) return app(req, res, next);
        if (req.url === '/auth-fixture') {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><title>T04 real auth fixture</title>');
          return;
        }
        next();
      });
    } }],
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  process.env.AUTH_ORIGIN = origin;
  process.env.ALLOWED_ORIGINS = origin;
  const auth = await import('../apps/server/dist/auth.js');
  closeAuthResources = auth.closeAuthResources;
  ({ closeDatabasePool } = await import('../apps/server/dist/database.js'));
  const { getAuthPool } = await import('../apps/server/dist/auth-meta.js');
  const { defaultStorageRepository: repository } = await import('../apps/server/dist/storage.js');
  const { createApp } = await import('../apps/server/dist/app.js');
  await auth.ensureAuthReady();
  app = createApp({ authHandler: auth.createAuthNodeHandler(), resolveRequestContext: auth.resolveRequestContext,
    storageRepository: repository, findPublicProfile: repository.findPublicProfileByIdentifier,
    generateRecommendation: async () => { throw new Error('Unexpected AI request'); } });
  const pool = getAuthPool();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const externalRequests = [];
  let injected = 0;
  let realSignOuts = 0;
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { externalRequests.push(url.origin); await route.abort(); return; }
    if (url.pathname === '/api/auth/sign-out') {
      if (injected < 2) {
        injected++;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'UNAVAILABLE', message: 'synthetic temporary outage' }) });
        return;
      }
      realSignOuts++;
    }
    await route.continue();
  });
  await page.goto(`${origin}/auth-fixture`);
  const accountA = await page.evaluate(async () => {
    const auth = await import('/src/auth.ts');
    const registered = await auth.registerWithEmail({ email: 'browser-a@example.test', username: 'browserownera', password: 'synthetic-browser-password', name: 'Browser A' });
    const status = await auth.getMigrationStatus();
    auth.cacheOfflineAccount(registered.user, status);
    return { id: registered.user.id, storageKey: status.storageKey, session: auth.getCurrentSession()?.user.id };
  });
  assert.equal(accountA.session, accountA.id);
  const originalCookies = await page.context().cookies();
  const originalToken = originalCookies.find(cookie => cookie.name === 'better-auth.session_token');
  assert.ok(originalToken?.httpOnly, 'server issued a genuine HttpOnly session cookie');
  assert.equal((await pool.query('SELECT id FROM session WHERE user_id = $1', [accountA.id])).rowCount, 1);
  const dataBefore = await repository.readSnapshot(accountA.storageKey);
  await page.evaluate(async () => { await (await import('/src/auth.ts')).signOut(); });
  assert.equal(injected, 1);
  assert.equal(realSignOuts, 0);
  assert.equal((await page.context().cookies()).find(cookie => cookie.name === originalToken.name)?.value, originalToken.value);
  assert.equal((await pool.query('SELECT id FROM session WHERE user_id = $1', [accountA.id])).rowCount, 1, '503 never reached the server');
  const locked = () => page.evaluate(async () => {
    const auth = await import('/src/auth.ts');
    return { current: auth.getCurrentUser(), storage: auth.getActiveStorageKey(), offline: auth.hasOfflineAccount(), pending: Boolean(localStorage.getItem('gym21_pending_sign_out_v1')) };
  });
  assert.deepEqual(await locked(), { current: null, storage: null, offline: false, pending: true });
  await page.reload();
  assert.deepEqual(await locked(), { current: null, storage: null, offline: false, pending: true });
  assert.equal(realSignOuts, 0, 'module initialization does not silently restore the old cookie');
  assert.equal(await page.evaluate(async () => (await (await import('/src/auth.ts')).restoreSessionState()).status), 'unavailable');
  assert.equal(injected, 2, 'reload restoration retries sign-out and still receives 503');
  assert.deepEqual(await locked(), { current: null, storage: null, offline: false, pending: true });
  assert.equal((await page.context().cookies()).find(cookie => cookie.name === originalToken.name)?.value, originalToken.value);
  assert.equal((await pool.query('SELECT id FROM session WHERE user_id = $1', [accountA.id])).rowCount, 1);
  assert.equal(await page.evaluate(async () => (await (await import('/src/auth.ts')).restoreSessionState()).status), 'unauthenticated');
  assert.equal(realSignOuts, 1);
  assert.equal((await pool.query('SELECT id FROM session WHERE user_id = $1', [accountA.id])).rowCount, 0);
  assert.equal((await page.context().cookies()).some(cookie => cookie.name === originalToken.name), false);
  assert.deepEqual(await locked(), { current: null, storage: null, offline: false, pending: false });
  const accountB = await page.evaluate(async () => {
    const auth = await import('/src/auth.ts');
    const registered = await auth.registerWithEmail({ email: 'browser-b@example.test', username: 'browserownerb', password: 'synthetic-browser-password', name: 'Browser B' });
    const status = await auth.getMigrationStatus();
    auth.cacheOfflineAccount(registered.user, status);
    return { id: registered.user.id, storageKey: status.storageKey, session: auth.getCurrentSession()?.user.id };
  });
  assert.notEqual(accountB.id, accountA.id);
  assert.notEqual(accountB.storageKey, accountA.storageKey);
  assert.equal(accountB.session, accountB.id);
  const staleWrite = await page.evaluate(async storageKey => {
    const response = await fetch('/api/me/storage/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Expected-Storage-Key': storageKey }, body: JSON.stringify({ protocolVersion: 1, cursor: 0, changes: {} }) });
    return { status: response.status, body: await response.json() };
  }, accountA.storageKey);
  assert.equal(staleWrite.status, 409);
  assert.equal(JSON.stringify(staleWrite.body).includes('browser-a@example.test'), false);
  assert.deepEqual(await repository.readSnapshot(accountA.storageKey), dataBefore);
  assert.deepEqual(externalRequests, []);
  assert.equal(realSignOuts, 1, 'old logout is never replayed over the new B cookie');
  console.log('T04 Chromium/real PostgreSQL: issued HttpOnly A cookie → resolved sign-out 503 → durable lock after reload → real sign-out deletes cookie and SQL session → B login → stale A context rejected 409; A data unchanged.');
} finally {
  await browser?.close();
  await server?.close();
  await closeAuthResources?.();
  await closeDatabasePool?.();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  await rm(envDir, { recursive: true, force: true });
}
