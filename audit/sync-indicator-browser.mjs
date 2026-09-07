// S05: isolated DOM/CSS fixture, no real env, authentication, cookies or account data.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const envDir = await mkdtemp(join(tmpdir(), 'gym21-s05-env-'));
const server = await createServer({ root: resolve('apps/client'), configFile: false, envDir,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { entries: [], include: ['dexie', 'zod', 'better-auth/client', '@better-auth/passkey/client'] },
  plugins: [{ name: 'synthetic-page', configureServer(s) { s.middlewares.use('/s05-test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>S05</title><div id="app"></div>'); }); } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/api/**', route => route.abort());
  await page.goto(`${server.resolvedUrls.local[0]}s05-test`);
  await page.evaluate(async () => {
    await import('/src/styles/components.css');
    const { createApplication } = await import('/src/ui/application.ts');
    let statusChange;
    let activeSession = true;
    let user = { id: 'synthetic', name: 'Synthetic' };
    const counts = { sync: 0, reconnect: 0, unsubscribe: 0 };
    const storage = {
      isActive: () => true, getStorageKey: () => 'synthetic',
      getSyncState: () => ({ pendingCount: 2, error: { message: 'Запись слишком большая: уменьшите описание' } }),
      getWorkoutTypes: () => [], getLogs: () => [], getWorkouts: () => [], getLatestLog: () => undefined, getLogsInDayRange: () => [],
      getTimeZone: () => 'UTC', getProfile: () => ({ isPublic: false }), getActiveWorkout: () => undefined,
      onUpdate: () => () => { }, onUnauthorized: () => () => { },
      onSyncStatusChange: callback => { statusChange = callback; return () => { counts.unsubscribe++; }; },
      sync: async () => { counts.sync++; },
    };
    const ui = createApplication({ storage, getCurrentUser: () => user, hasActiveSession: () => activeSession,
      captureAccountContext: () => ({ storageKey: 'synthetic' }), getOfflineAccount: () => null,
      loadTelegramWebApp: async () => null,
      createReconnectCoordinator: () => ({ retry: async () => { counts.reconnect++; }, dispose: () => { } }),
    });
    await ui.mount();
    ui.navigate({ name: 'settings' });
    statusChange('error');
    window.fixture = { ui, counts, offline: () => { activeSession = false; statusChange('idle'); }, guest: () => { user = null; window.dispatchEvent(new Event('gym21-auth-changed')); } };
  });
  assert.equal(await page.locator('.sync-status').count(), 1);
  assert.match(await page.locator('.sync-status').innerText(), /Запись слишком большая.*Ожидают отправки: 2/s);
  await page.locator('.sync-status button').click();
  await page.locator('#new-type-name').fill('Unsaved exercise');
  await page.evaluate(() => window.fixture.ui.render());
  assert.equal(await page.locator('#new-type-name').inputValue(), 'Unsaved exercise');
  await page.locator('.sync-status button').click();
  await page.evaluate(() => window.fixture.offline());
  assert.match(await page.locator('.sync-status').innerText(), /изменения сохраняются на устройстве/);
  await page.locator('.sync-status button').click();
  assert.deepEqual(await page.evaluate(() => window.fixture.counts), { sync: 2, reconnect: 2, unsubscribe: 0 });
  const box = await page.locator('.sync-status').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  await page.evaluate(() => window.fixture.guest());
  assert.equal(await page.locator('.sync-status').isVisible(), false);
  assert.equal(await page.locator('.sync-status').textContent(), '');
  await page.evaluate(() => window.fixture.ui.dispose());
  assert.equal(await page.locator('.sync-status').count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.counts.unsubscribe), 1);
  console.log(JSON.stringify({ singleIndicator: true, realCssPointerClicks: 3, manualSync: 2, offlineReconnect: 1, drafts: true, guestCleared: true, disposed: true, mobileBounds: true }));
} finally { await browser?.close(); await server.close(); await rm(envDir, { recursive: true, force: true }); }
