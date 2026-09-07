// Synthetic Chromium IndexedDB regression; no user profile, cookies, env files or API.
// Set PLAYWRIGHT_MODULE_PATH to an installed playwright/index.mjs when not on NODE_PATH.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const emptyEnvDir = await mkdtemp(join(tmpdir(), 'gym21-a11-env-'));
const server = await createServer({
  root: resolve('apps/client'), configFile: false, envDir: emptyEnvDir,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { entries: [], include: ['dexie', 'zod', 'better-auth/client', '@better-auth/passkey/client'] },
  plugins: [{ name: 'synthetic-test-page', configureServer(instance) {
    instance.middlewares.use('/a11-test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>A11 synthetic regression</title>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const seen = new Set();
  let requests = 0;
  let attempts = 0;
  let retryNotBefore = 0;
  let revision = 0;
  let largestBody = 0;
  const now = '2026-09-01T00:00:00.000Z';
  const user = { id: 'synthetic-a11', name: 'Synthetic', email: 'synthetic@example.test', emailVerified: true, createdAt: now, updatedAt: now };
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/auth/get-session') {
      await route.fulfill({ json: { session: { id: 'synthetic', userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z', token: 'synthetic' }, user } });
      return;
    }
    assert.equal(new URL(route.request().url()).pathname, '/api/me/storage/sync');
    assert.equal(route.request().headers()['x-expected-storage-key'], user.id);
    assert.ok(Date.now() >= retryNotBefore - 50, 'Retry-After must not be bypassed');
    attempts++;
    if (attempts === 1 || attempts === 22) {
      retryNotBefore = Date.now() + 2000;
      await route.fulfill({ status: attempts === 1 ? 503 : 429, headers: { 'Retry-After': '2' }, json: { code: 'ROUTE_BUSY' } });
      return;
    }
    const body = route.request().postData();
    largestBody = Math.max(largestBody, Buffer.byteLength(body));
    assert.ok(Buffer.byteLength(body) <= 512 * 1024);
    const sent = JSON.parse(body);
    assert.ok(sent.changes.logs.length > 0 && sent.changes.logs.length <= 500);
    const logs = sent.changes.logs.map((log) => {
      assert.equal(seen.has(log.id), false); seen.add(log.id);
      return { ...log, version: ++revision, serverUpdatedAt: now };
    });
    requests++;
    await route.fulfill({ json: { cursor: revision, changes: { logs }, conflicts: [],
      acknowledged: logs.map(({ id }) => ({ entityType: 'logs', entityId: id })), hasMore: false } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}a11-test`);
  await page.evaluate(async (user) => {
    const auth = await import('/src/auth.ts');
    const { StorageService } = await import('/src/storage/storage.ts');
    const { SyncService } = await import('/src/services/sync.ts');
    const database = await import('/src/db.ts');
    const restored = await auth.restoreSessionState();
    if (restored.status !== 'authenticated') throw new Error(`Auth fixture failed: ${restored.status}`);
    auth.cacheOfflineAccount(user, { storageKey: user.id });
    const storage = new StorageService({ autoInit: false, enableBroadcast: false, syncDebounceMs: 0 });
    await storage.activate(user.id);
    const db = database.db;
    await db.workoutTypes.put({ id: 'T', name: 'Synthetic', updatedAt: user.updatedAt, version: 1 });
    const logs = Array.from({ length: 10001 }, (_, i) => ({ id: `L${i}`, workoutTypeId: 'T', workoutId: 'W', date: user.updatedAt, updatedAt: user.updatedAt, reps: 1 }));
    await db.logs.bulkPut(logs);
    await SyncService.markDirtyMany([...logs.map(({ id }) => ({ entityType: 'logs', entityId: id })), { entityType: 'logs', entityId: 'missing' }]);
    window.a11 = { storage, db };
    await storage.sync();
  }, user);
  const deadline = Date.now() + 60000;
  while (await page.evaluate(() => window.a11.db.dirtyEntities.count()) > 0) {
    if (Date.now() >= deadline) throw new Error('Outbox did not drain within 60 seconds');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const result = await page.evaluate(async () => {
    const logs = await window.a11.db.logs.toArray();
    window.a11.storage.dispose();
    return { count: logs.length, versioned: logs.filter(x => x.version > 0).length };
  });
  assert.deepEqual(result, { count: 10001, versioned: 10001 });
  assert.equal(seen.size, 10001); assert.equal(requests, 21); assert.equal(attempts, 23);
  console.log(JSON.stringify({ browser: 'Chromium', logs: seen.size, requests, attempts, largestBody, outbox: 0 }));
} finally {
  await browser?.close();
  await server.close();
  await rm(emptyEnvDir, { recursive: true, force: true });
}
