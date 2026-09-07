// S06: isolated DOM/CSS fixture, no real env, authentication, cookies or account data.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const envDir = await mkdtemp(join(tmpdir(), 'gym21-s06-env-'));
const server = await createServer({ root: resolve('apps/client'), configFile: false, envDir,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { entries: [], include: ['dexie', 'zod', 'better-auth/client', '@better-auth/passkey/client'] },
  plugins: [{ name: 'synthetic-page', configureServer(s) { s.middlewares.use('/s06-test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>S06</title><div id="app"></div>'); }); } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/api/**', route => route.abort());
  await page.goto(`${server.resolvedUrls.local[0]}s06-test`);
  await page.evaluate(async () => {
    await import('/src/styles/components.css');
    const { createApplication } = await import('/src/ui/application.ts');
    let refresh = () => {};
    const types = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, name: i === 1 ? 'Running' : `Exercise ${i}`, category: i === 1 ? 'time' : 'strength' }));
    window.orders = [];
    const storage = { isActive: () => true, getStorageKey: () => 'synthetic', getSyncState: () => ({ pendingCount: 0 }),
      getWorkoutTypes: () => types, getLogs: () => [], getWorkouts: () => [], getLatestLog: () => undefined, getLogsInDayRange: () => [], getTimeZone: () => 'UTC', getProfile: () => ({}), getActiveWorkout: () => null,
      onUpdate: fn => { refresh = fn; return () => {}; }, onUnauthorized: () => () => {}, onSyncStatusChange: () => () => {},
      updateWorkoutTypeOrder: async ids => { window.orders.push(ids); }
    };
    const ui = createApplication({ storage, getCurrentUser: () => ({ name: 'Synthetic' }), captureAccountContext: () => ({ storageKey: 'synthetic' }) });
    await ui.mount({ bootstrap: false }); ui.navigate({ name: 'main' });
    window.ui = ui; window.refresh = () => refresh();
  });
  await page.locator('[data-typeahead-input]').fill('rnn');
  await page.evaluate(() => { window.oldInput = document.querySelector('[data-typeahead-input]'); window.refresh(); });
  assert.equal(await page.locator('[data-typeahead-input]').inputValue(), 'rnn');
  await page.locator('[data-typeahead-input]').click();
  await page.locator('[data-typeahead-option-index="0"]').click();
  assert.equal(await page.locator('[data-typeahead-value]').inputValue(), 't1');
  await page.evaluate(() => { window.oldInput.value = 'detached'; document.body.click(); });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.oldInput.value), 'detached');
  await page.evaluate(() => window.ui.navigate({ name: 'settings' }));
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.ui.pages.settings.refresh());
  const source = await page.locator('.drag-handle').nth(0).boundingBox();
  const target = await page.locator('.drag-handle').nth(2).boundingBox();
  await page.mouse.move(source.x + 5, source.y + 5);
  await page.mouse.down();
  await page.mouse.move(target.x + 5, target.y + target.height - 2, { steps: 20 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.orders.length), 1);
  assert.notEqual(await page.evaluate(() => window.orders[0][0]), 't0');
  await page.evaluate(() => { window.ui.navigate({ name: 'main' }); window.ui.dispose(); });
  console.log('S06 real Chromium: refreshed draft + selection, detached blur/outside click, repeated settings refresh + actual drag reorder + navigation/dispose passed');
} finally { await browser?.close(); await server.close(); await rm(envDir, { recursive: true, force: true }); }
