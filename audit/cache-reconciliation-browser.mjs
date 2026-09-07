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
const emptyEnvDir = await mkdtemp(join(tmpdir(), 'gym21-o01-env-'));
const server = await createServer({
  root: resolve(process.env.O01_CLIENT_ROOT || 'apps/client'), configFile: false, envDir: emptyEnvDir,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { entries: [], include: ['dexie', 'zod', 'better-auth/client', '@better-auth/passkey/client'] },
  plugins: [{ name: 'synthetic-test-page', configureServer(instance) {
    instance.middlewares.use('/o01-test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>O01 synthetic regression</title>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context = await browser.newContext();
  await context.route('**/api/**', route => route.fulfill({status: 503, json:{}}));
  const first = await context.newPage(), second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto(`${server.resolvedUrls.local[0]}o01-test`);
    await page.evaluate(async () => {
      const {StorageService} = await import('/src/storage/storage.ts');
      const {AccountReads} = await import('/src/storage/account-reads.ts');
      const {SyncService} = await import('/src/services/sync.ts');
      const storage = new StorageService({enableBroadcast:true});
      await storage.activate('cross-tab-synthetic');
      window.fixture = {storage, AccountReads, updates:0, fullReads:0};
      storage.onUpdate(() => window.fixture.updates++);
      const original = SyncService.prototype.readAll;
      SyncService.prototype.readAll = function(...args) { window.fixture.fullReads++; return original.apply(this,args); };
    });
  }
  const id = await first.evaluate(async () => (await window.fixture.storage.addWorkoutType('first')).id);
  await second.waitForFunction(id => window.fixture.storage.getWorkoutTypeById(id)?.name === 'first', id);
  const initialReads = await second.evaluate(() => window.fixture.fullReads);
  assert.equal(initialReads,1, 'first unknown sender reconciles once');
  await first.evaluate(async id => {
    const {AccountReads,storage} = window.fixture;
    const original = AccountReads.prototype.flush;
    let once = true;
    AccountReads.prototype.flush = async function() {
      if (once) { once = false; await original.call(this); } // Another refresh drained the own commit.
      return original.call(this);
    };
    await storage.updateWorkoutType(id,'after-race');
    AccountReads.prototype.flush = original;
  },id);
  await second.waitForFunction(id => window.fixture.storage.getWorkoutTypeById(id)?.name === 'after-race',id);
  assert.equal(await second.evaluate(() => window.fixture.fullReads),initialReads,'follow-up must use delta');
  await second.evaluate(async () => { await window.fixture.storage.activate('different-account'); window.fixture.updates = 0; });
  await first.evaluate(id => window.fixture.storage.updateWorkoutType(id,'account-A-only'),id);
  await second.waitForTimeout(150);
  assert.deepEqual(await second.evaluate(id => ({updates:window.fixture.updates, has:!!window.fixture.storage.getWorkoutTypeById(id)}),id),{updates:0,has:false});
  for (const page of [first,second]) await page.evaluate(() => window.fixture.storage.dispose());
  console.log(JSON.stringify({browser:'Chrome', firstSenderReconcile:1, followupFullReads:0, outgoingDrainRace:true, accountIsolation:true}));
} finally { await browser?.close(); await server.close(); await rm(emptyEnvDir,{recursive:true,force:true}); }
