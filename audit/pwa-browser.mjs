// T05: unmodified production main, real Chromium SW/IndexedDB and mounted API/PostgreSQL.
// Only synthetic accounts, disposable builds/schema, no workspace environment files.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { Pool } from 'pg';
import '../apps/server/scripts/require-test-database.mjs';
if (process.exitCode) throw new Error('PWA fixture stopped: PostgreSQL preflight failed.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const scratch = await mkdtemp(join(tmpdir(), 'gym21-pwa-'));
const schema = `pwa_browser_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.GYM21_TEST_DATABASE_URL });
let browser, server, closeAuthResources, closeDatabasePool;
let outputDir = join(scratch, 'v1');
let app;
let rejectSync = false;
let backupRace = false;
let repository;
let holdNextSync = false;
let releaseHeldSync;
let heldSyncReady = false;
const syncRequests = [];
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const buildVersion = async version => {
  const outDir = join(scratch, version);
  await build({ root: resolve('apps/client'), envDir: scratch, build: { outDir, emptyOutDir: true },
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.VITE_AUTH_BASE_URL': JSON.stringify('/api/auth') },
    plugins: [{ name: 'fixture-release-marker', transformIndexHtml: { order: 'pre', handler: html => html.replace('<title>', `<meta name="fixture-release" content="${version}"><title>`) } }],
  });
  return outDir;
};
const eventually = async (check, message) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(message);
};
// Read actual IndexedDB via browser APIs; no imported application internals or write seams.
const localRows = (page, key, table) => page.evaluate(async ({ key, table }) => {
  const db = await new Promise((resolve, reject) => { const req = indexedDB.open(`GymDatabase:account:${key}`); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  try { return await new Promise((resolve, reject) => { const req = db.transaction(table).objectStore(table).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); } finally { db.close(); }
}, { key, table });
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const dbUrl = new URL(process.env.GYM21_TEST_DATABASE_URL);
  dbUrl.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = dbUrl.toString(); delete process.env.DATABASE_SSL;
  process.env.BETTER_AUTH_SECRET = 'pwa-fixture-secret-synthetic-at-least-32-characters';
  process.env.TELEGRAM_BOT_TOKEN = 'pwa-synthetic-token'; process.env.RATE_LIMITS_ENABLED = 'false';
  outputDir = await buildVersion('v1');
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/api/')) {
        if (pathname.endsWith('/storage/sync')) {
          syncRequests.push(req.headers['x-expected-storage-key']);
          if (holdNextSync) {
            holdNextSync = false;
            const originalEnd = res.end.bind(res);
            res.end = (...args) => {
              heldSyncReady = true;
              releaseHeldSync = () => originalEnd(...args);
              return res;
            };
          }
          if (rejectSync) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"message":"synthetic outage"}'); return; }
        }
        if (backupRace && pathname.endsWith('/storage/backup')) {
          backupRace = false;
          await repository.updateProfileFromAuth(req.headers['x-expected-storage-key'], { name: 'Concurrent remote profile' });
        }
        app(req, res); return;
      }
      const filename = extname(pathname) ? pathname : '/index.html';
      const body = await readFile(join(outputDir, filename));
      res.writeHead(200, { 'Content-Type': contentTypes[extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.AUTH_ORIGIN = origin; process.env.ALLOWED_ORIGINS = origin;
  const auth = await import('../apps/server/dist/auth.js'); closeAuthResources = auth.closeAuthResources;
  ({ closeDatabasePool } = await import('../apps/server/dist/database.js'));
  ({ defaultStorageRepository: repository } = await import('../apps/server/dist/storage.js'));
  const { createApp } = await import('../apps/server/dist/app.js');
  await auth.ensureAuthReady();
  app = createApp({ authHandler: auth.createAuthNodeHandler(), resolveRequestContext: auth.resolveRequestContext, storageRepository: repository, findPublicProfile: repository.findPublicProfileByIdentifier, generateRecommendation: async () => { throw new Error('Unexpected AI'); } });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  context.setDefaultTimeout(20000);
  const networkSessions = new Map();
  const networkState = async offline => {
    await context.setOffline(offline);
    // Chromium resets navigator state on SW offline navigation even while transport
    // remains offline. CDP restores native network state/events, never calls app sync.
    for (const target of context.pages()) {
      let session = networkSessions.get(target);
      if (!session) { session = await context.newCDPSession(target); networkSessions.set(target, session); }
      await session.send('Network.overrideNetworkState', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  };
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const workers = []; context.on('serviceworker', worker => workers.push(worker.url()));
  const page = await context.newPage();
  page.on('pageerror', e => console.error('PWA page error:', e.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { window.networkEvents = []; window.addEventListener('online', () => window.networkEvents.push('online')); window.addEventListener('offline', () => window.networkEvents.push('offline')); });
  await page.goto(origin);
  await page.locator('#auth-mode-sign-up').click();
  await page.locator('#auth-email').fill('pwa-a@example.test');
  await page.locator('#auth-name').fill('PWA A');
  await page.locator('#auth-username').fill('pwaownera');
  await page.locator('#auth-password').fill('synthetic-pwa-password');
  await page.locator('#email-auth-form button[type=submit]').click();
  await page.locator('[data-page=settings]').waitFor();
  const keyA = await page.evaluate(() => JSON.parse(localStorage.getItem('gym21_offline_accounts_v1')).activeStorageKey);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const manifest = await cdp.send('Page.getAppManifest');
  assert.deepEqual(manifest.errors, []);
  assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
  const manifestData = JSON.parse(manifest.data);
  assert.equal(manifestData.name, 'Gym Gym 21');
  assert.ok(manifestData.icons.some(icon => icon.sizes === '512x512'));
  await page.locator('[data-page=settings]').click();
  await page.locator('#new-type-name').fill('Online seed');
  await page.locator('#add-type-form button[type=submit]').click();
  await eventually(async () => (await repository.readSnapshot(keyA)).workoutTypes.some(x => x.name === 'Online seed'), 'Initial UI save did not reach real PG');
  await eventually(async () => (await localRows(page, keyA, 'dirtyEntities')).length === 0, 'Initial outbox not drained');
  await networkState(true);
  await page.reload({ waitUntil: 'domcontentloaded' }); await networkState(true); assert.equal(await page.evaluate(() => navigator.onLine), false);
  await page.locator('[data-page=settings]').click();
  await page.getByText('Online seed', { exact: true }).waitFor();
  await page.locator('#new-type-name').fill('Offline saved');
  await page.locator('#add-type-form button[type=submit]').click();
  await eventually(async () => (await localRows(page, keyA, 'dirtyEntities')).length > 0, 'Offline UI save missing from outbox');
  assert.equal((await repository.readSnapshot(keyA)).workoutTypes.some(x => x.name === 'Offline saved'), false);
  // Actual offline startup → online event; no reload or direct sync call.
  await page.locator('#new-type-name').fill('Draft during reconnect');
  await networkState(false); assert.equal(await page.evaluate(() => navigator.onLine), true);
  await eventually(async () => (await repository.readSnapshot(keyA)).workoutTypes.some(x => x.name === 'Offline saved'), 'Reconnect failed to push offline save');
  await eventually(async () => (await localRows(page, keyA, 'dirtyEntities')).length === 0, 'Reconnect outbox not drained');
  assert.equal(await page.locator('#new-type-name').inputValue(), 'Draft during reconnect');
  await page.locator('#add-type-form button[type=submit]').click();
  await eventually(async () => (await repository.readSnapshot(keyA)).workoutTypes.some(x => x.name === 'Draft during reconnect'), 'Draft submit lost typed value');
  assert.ok(await page.evaluate(() => window.networkEvents.includes('online')), 'Native online event absent');
  console.log('T05: real SW offline startup → UI save → automatic online auth+sync; reconnect draft submitted intact.');
  // Backup UI file chooser, offline merge and forbidden replace, real online replacement.
  const dataTab = async () => { await page.locator('[data-page=profile-settings]').click(); await page.locator('[data-tab=data]').click(); };
  const imported = { format: 'gym21-backup', version: 1, exportedAt: '2026-09-01T00:00:00Z', data: { workoutTypes: [{ id: 'backup-type', name: 'Backup exercise', category: 'strength', updatedAt: '2026-09-01T00:00:00Z' }], logs: [], workouts: [] } };
  const importFile = async mode => {
    await page.locator('#import-mode').selectOption(mode);
    const chooser = page.waitForEvent('filechooser'); await page.locator('#import-json-btn').click();
    await (await chooser).setFiles({ name: 'synthetic-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  };
  await networkState(true); await dataTab(); await importFile('merge');
  await eventually(async () => (await localRows(page, keyA, 'workoutTypes')).some(x => x.id === 'backup-type'), 'Offline backup merge absent');
  const beforeForbidden = await localRows(page, keyA, 'workoutTypes');
  await importFile('replace');
  await page.locator('.toast').filter({ hasText: /онлайн|подключ/i }).waitFor();
  assert.deepEqual(await localRows(page, keyA, 'workoutTypes'), beforeForbidden);
  await networkState(false);
  await eventually(async () => (await localRows(page, keyA, 'dirtyEntities')).length === 0, 'Backup merge outbox not drained');
  const beforeRace = await repository.readSnapshot(keyA);
  backupRace = true;
  const conflictResponse = page.waitForResponse(r => r.url().endsWith('/storage/backup') && r.status() === 409);
  await importFile('replace'); await conflictResponse;
  await page.locator('.toast').filter({ hasText: /измен|conflict|синхрон/i }).waitFor();
  assert.deepEqual((await repository.readSnapshot(keyA)).workoutTypes, beforeRace.workoutTypes, 'Revision conflict changed entities');
  assert.deepEqual(await localRows(page, keyA, 'dirtyEntities'), [], 'Failed replace introduced pending changes');
  await importFile('replace');
  await eventually(async () => { const types = (await repository.readSnapshot(keyA)).workoutTypes.filter(x => !x.isDeleted); return types.length === 1 && types[0].id === 'backup-type'; }, 'Online backup replace did not tombstone missing records');
  console.log('T05: real file chooser → offline merge/outbox, offline replace rejected without mutation, online atomic replacement in PG.');
  // Install next production release, real registration.update/controllerchange, persisted pending data.
  await page.locator('[data-page=settings]').click(); rejectSync = true;
  await page.locator('#new-type-name').fill('Survives SW update'); await page.locator('#add-type-form button[type=submit]').click();
  await eventually(async () => (await localRows(page, keyA, 'dirtyEntities')).length > 0, 'Pending update fixture missing');
  const oldCaches = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(r => r.url)))).flat());
  outputDir = await buildVersion('v2');
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
  await eventually(async () => { try { return await page.locator('meta[name=fixture-release]').getAttribute('content') === 'v2'; } catch { return false; } }, 'Real SW update did not reload new release');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  assert.ok((await localRows(page, keyA, 'dirtyEntities')).length > 0);
  assert.ok((await localRows(page, keyA, 'workoutTypes')).some(x => x.name === 'Survives SW update'));
  const newCaches = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(r => r.url)))).flat());
  const obsolete = oldCaches.filter(url => !newCaches.includes(url));
  assert.ok(workers.length >= 2, 'Second actual service worker was not created');
  assert.ok(obsolete.some(url => url.includes('index.html')), 'Old precache revision was not removed');
  await networkState(true); await page.reload({ waitUntil: 'domcontentloaded' }); await networkState(true);
  assert.equal(await page.locator('meta[name=fixture-release]').getAttribute('content'), 'v2');
  await page.locator('[data-page=settings]').click(); await page.getByText('Survives SW update', { exact: true }).waitFor();
  rejectSync = false; await networkState(false);
  await eventually(async () => (await localRows(page, keyA, 'dirtyEntities')).length === 0, 'Updated app did not sync pending data');
  console.log('T05: fresh SW activation/control + manifest, actual v2 install/activation/reload/cache revision cleanup; offline v2 navigation and pending IndexedDB data survive.');
  // Two actual main pages share cookies, but account repositories and pending generations do not.
  const other = await context.newPage(); other.on('dialog', d => d.accept());
  await other.goto(origin); await other.locator('[data-page=settings]').click();
  await page.locator('#new-type-name').fill('A unsaved draft');
  await other.locator('#new-type-name').fill('Background tab save');
  await other.locator('#add-type-form button[type=submit]').click();
  await page.getByText('Background tab save', { exact: true }).waitFor();
  assert.equal(await page.locator('#new-type-name').inputValue(), 'A unsaved draft');
  await page.bringToFront();
  assert.equal(await page.locator('#new-type-name').inputValue(), 'A unsaved draft');
  await eventually(async () => (await localRows(page, keyA, 'dirtyEntities')).length === 0, 'Background tab sync pending');
  holdNextSync = true;
  await page.locator('#new-type-name').fill('A delayed acknowledgement');
  await page.locator('#add-type-form button[type=submit]').click();
  await eventually(() => heldSyncReady, 'No actual A response held');
  await page.locator('#new-type-name').fill('A draft must not become B');
  const pendingA = await localRows(page, keyA, 'dirtyEntities');
  assert.ok(pendingA.length > 0);
  await other.locator('[data-page=profile-settings]').click(); await other.locator('#sign-out-btn').click();
  await other.locator('#auth-mode-sign-up').click();
  await other.locator('#auth-email').fill('pwa-b@example.test'); await other.locator('#auth-name').fill('PWA B');
  await other.locator('#auth-username').fill('pwaownerb'); await other.locator('#auth-password').fill('synthetic-pwa-password');
  await other.locator('#email-auth-form button[type=submit]').click();
  await other.locator('[data-page=settings]').click();
  const keyB = await other.evaluate(() => JSON.parse(localStorage.getItem('gym21_offline_accounts_v1')).activeStorageKey);
  assert.notEqual(keyA, keyB);
  releaseHeldSync(); releaseHeldSync = undefined;
  await other.locator('#new-type-name').fill('Only B exercise'); await other.locator('#add-type-form button[type=submit]').click();
  await eventually(async () => (await repository.readSnapshot(keyB)).workoutTypes.some(x => x.name === 'Only B exercise'), 'B UI did not save');
  assert.deepEqual(await localRows(other, keyA, 'dirtyEntities'), pendingA, 'Late A acknowledgement cleared inactive account outbox');
  assert.ok(!(await localRows(other, keyB, 'workoutTypes')).some(x => x.name.startsWith('A ') || x.name === 'Backup exercise'));
  assert.ok(!(await repository.readSnapshot(keyB)).workoutTypes.some(x => x.name.startsWith('A ') || x.name === 'Backup exercise'));
  // Reconnect original tab using shared B cookie: it must select B before any next sync.
  await networkState(true); await networkState(false);
  await eventually(async () => { try { return await page.locator('#new-type-name').inputValue() === ''; } catch { return false; } }, 'Original tab kept A draft after account transition');
  assert.deepEqual(await localRows(page, keyA, 'dirtyEntities'), pendingA);
  console.log('T05: two real main tabs preserve draft during BroadcastChannel refresh/visibility; shared cookie A→B, held real A response cannot clear inactive outbox or contaminate B; original tab reconnect clears A draft.');
  assert.ok(syncRequests.every(Boolean), 'Actual UI sent an unguarded sync');
} finally {
  releaseHeldSync?.();
  console.log('PWA cleanup'); await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await closeAuthResources?.(); await closeDatabasePool?.();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  await rm(scratch, { recursive: true, force: true });
}
