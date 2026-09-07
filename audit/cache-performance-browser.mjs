// Synthetic Chromium IndexedDB regression; no user profile, cookies, env files or API.
// Set PLAYWRIGHT_MODULE_PATH to an installed playwright/index.mjs when not on NODE_PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const emptyEnvDir = await mkdtemp(join(tmpdir(), 'gym21-o01-env-'));
const server = await createServer({
  root: resolve('apps/client'), configFile: false, envDir: emptyEnvDir,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { entries: [], include: ['dexie', 'zod', 'better-auth/client', '@better-auth/passkey/client'] },
  plugins: [{ name: 'committed-baseline', enforce: 'pre', load(id) {
    if (!process.argv.includes('--baseline') || !id.startsWith(resolve('apps/client/src') + '/') || !id.endsWith('.ts')) return;
    const path = id.slice(resolve('.').length + 1);
    return execFileSync('git', ['show', `${process.env.O01_BASELINE_REF || 'de0780b388a62653e3ad88912f7c5e065b454ec6'}:${path}`], {encoding:'utf8'});
  } }, { name: 'synthetic-test-page', configureServer(instance) {
    instance.middlewares.use('/o01-test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>O01 synthetic regression</title>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page = await browser.newPage();
  await page.route('**/api/**', route => route.fulfill({status: 503, json: {}}));
  await page.goto(`${server.resolvedUrls.local[0]}o01-test`);
  for (const count of [10000, 100000]) {
    console.log(`Starting ${count} logs`);
    const result = await page.evaluate(async count => {
      const { StorageService } = await import('/src/storage/storage.ts');
      const database = await import('/src/db.ts');
      const { createWorkoutPage } = await import('/src/ui/pages/workout.ts');
      const { createUiState } = await import('/src/ui/state.ts');
      const storage = new StorageService({enableBroadcast: false});
      await storage.activate(`o01-${count}`);
      const db = database.db;
      const now = new Date();
      await db.profile.put({id: 'me', timeZone: 'UTC', updatedAt: now.toISOString()});
      await db.workoutTypes.put({id: 'T', name: 'Synthetic', updatedAt: now.toISOString()});
      const logs = Array.from({length: count}, (_, i) => ({id: `L${String(i).padStart(6,'0')}`, workoutTypeId: 'T', workoutId: 'W', date: new Date(now.getTime() - i * 86400000).toISOString(), updatedAt: now.toISOString(), reps: 1}));
      await db.logs.bulkPut(logs);
      await storage.reloadCache();
      let readRows = 0;
      const originals = [];
      for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) for (const name of ['getAll', 'get', 'openCursor']) {
        const original = prototype[name];
        originals.push([prototype, name, original]);
        prototype[name] = function(...args) {
          const request = original.apply(this,args);
          if (['logs','workouts','workoutTypes','profile'].includes(this.objectStore?.name ?? this.name)) request.addEventListener('success', () => {
            const value = request.result;
            readRows += Array.isArray(value) ? value.length : value ? 1 : 0;
          });
          return request;
        };
      }
      const start = performance.now();
      await storage.updateLog({...logs[0], reps: 2});
      const mutationMs = performance.now() - start;
      const mutationReadRows = readRows;
      const workout = createWorkoutPage({state: createUiState(), dependencies: {storage}, actions: {render() {}, showToast() {}, withFormDrafts(fn) {fn();}}});
      const renderStart = performance.now();
      const html = workout.render();
      const renderMs = performance.now() - renderStart;
      // Also exercise the ordinary implicit-session add path with one session per day.
      const sessions = logs.map((log, i) => ({id: `W${i}`, startTime: log.date, endTime: log.date, status: 'finished', isManual: false, pauseIntervals: [], updatedAt: log.updatedAt}));
      await db.workouts.bulkPut(sessions);
      await db.logs.bulkPut(logs.map((log, i) => ({...log, workoutId: `W${i}`})));
      await storage.reloadCache();
      readRows = 0;
      const addStart = performance.now();
      const added = await storage.addLog({workoutTypeId: 'T', reps: 3});
      const addMs = performance.now() - addStart;
      const addReadRows = readRows;
      const addRenderStart = performance.now(); workout.render();
      const addRenderMs = performance.now() - addRenderStart;
      if (added.workoutId !== 'W0') throw new Error('Existing owner-day implicit session was not reused');
      const addSamples = [{ms: addMs, rows: addReadRows}];
      if (typeof storage.getLogsInDayRange === 'function') for (let trial = 0; trial < 2; trial++) {
        readRows = 0; const trialStart = performance.now();
        await storage.addLog({workoutTypeId:'T', reps:4 + trial});
        addSamples.push({ms:performance.now() - trialStart, rows:readRows});
        workout.render();
      }
      for (const [prototype, name, original] of originals) prototype[name] = original;
      storage.dispose();
      return {count, mutationMs, renderMs, readRows: mutationReadRows, addMs, addRenderMs, addReadRows, addSamples, htmlLength: html.length};
    }, count);
    assert.ok(result.htmlLength > 1000);
    if (!process.argv.includes('--baseline')) { assert.ok(result.readRows <= 4, 'ordinary edit must not read history'); assert.ok(result.addSamples.every(sample => sample.rows <= 20), 'ordinary add must only read day/session rows'); }
    console.log(JSON.stringify(result));
  }
} finally {
  await browser?.close(); await server.close(); await rm(emptyEnvDir, {recursive: true, force: true});
}
