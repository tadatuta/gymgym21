// Synthetic A15 Chromium/IndexedDB + production DOM handler. Never loads user env, cookies or data.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import ts from 'typescript';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const text = await readFile('apps/client/src/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
let callback;
const visit = node => {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'form?.addEventListener' && node.arguments[0]?.getText(ast) === "'submit'") callback = node.arguments[1];
  ts.forEachChild(node, visit);
}; visit(ast);
const renderer = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'generateLogsListHtml');
const compiled = ts.transpileModule(`const handler = ${callback.getText(ast)};\n${renderer.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
const envDir = await mkdtemp(join(tmpdir(), 'gym21-a15-env-'));
const server = await createServer({ root: resolve('apps/client'), configFile: false, envDir,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { entries: [], include: ['dexie', 'zod', 'better-auth/client', '@better-auth/passkey/client'] },
  plugins: [{ name: 'synthetic-page', configureServer(s) { s.middlewares.use('/a15-test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>A15</title>'); }); } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
  await page.route('**/api/**', route => route.abort());
  await page.goto(`${server.resolvedUrls.local[0]}a15-test`);
  const result = await page.evaluate(async compiled => {
    const { StorageService } = await import('/src/storage/storage.ts');
    const database = await import('/src/db.ts');
    const time = await import('/src/utils/training-time.ts');
    const safe = await import('/src/utils/safe-html.ts');
    const { formatDuration } = await import('/src/utils/duration.ts');
    const { getDurationStats } = await import('/src/utils/statistics.ts');
    const { renderDurationChart } = await import('/src/components/stats/Charts.ts');
    const storage = new StorageService({ enableBroadcast: false });
    await storage.activate('synthetic-a15');
    const activeDb = database.db;
    const stamp = '2026-01-01T21:30:00Z';
    await activeDb.profile.put({ id: 'me', timeZone: 'Europe/Moscow', isPublic: false, createdAt: stamp, updatedAt: stamp });
    const sessions = ['old', 'new'].map((id, i) => ({ id, startTime: i ? '2026-01-02T22:00:00Z' : stamp, endTime: i ? '2026-01-02T22:00:00Z' : stamp, isManual: false, status: 'finished', pauseIntervals: [], updatedAt: stamp }));
    await activeDb.workouts.bulkPut(sessions);
    await activeDb.logs.bulkPut(sessions.map(s => ({ id: s.id, workoutId: s.id, workoutTypeId: 'time', date: s.startTime, durationSeconds: 30, updatedAt: stamp })));
    await activeDb.workoutTypes.bulkPut([{ id: 'time', name: 'Time', category: 'time', updatedAt: stamp }, { id: 'strength', name: 'Strength', category: 'strength', updatedAt: stamp }]);
    await storage.reloadCache();
    document.body.innerHTML = '<form><input name="typeId" value="time"><input name="duration_seconds" value="0"><input name="date" value="2026-01-03T00:30"><input name="weight" value="20"><input name="reps" value="5"></form>';
    const form = document.querySelector('form');
    const context = { ...time, ...safe, formatDuration, form, storage, formDrafts: null, editingLogId: 'old', editingWorkoutId: null, lastAddedLogId: null, showToast: message => { throw new Error(message); }, render: () => {} };
    const { handler, generateLogsListHtml } = new Function(...Object.keys(context), `${compiled}; return { handler, generateLogsListHtml };`)(...Object.values(context));
    const card = generateLogsListHtml(storage.getLogs(), storage.getWorkoutTypes(), true);
    const duration = formatDuration(storage.getWorkoutDuration(sessions[0]) * 60);
    if (!card.includes(duration) || !renderDurationChart(sessions, storage.getLogs()).includes(duration) || getDurationStats(sessions, storage.getLogs()).averageSeconds !== 30) throw new Error('Duration mismatch');
    const publicHtml = generateLogsListHtml([storage.getLogs().find(l => l.id === 'old')], [], false, 'Europe/Moscow');
    if (!publicHtml.includes(time.dayLabel('2026-01-02'))) throw new Error('Viewer zone leaked');
    let pending;
    form.addEventListener('submit', e => { pending = handler(e); });
    const submit = async () => { form.dispatchEvent(new Event('submit', { cancelable: true })); await pending; };
    await submit();
    const cleared = await activeDb.logs.get('old');
    if (cleared.durationSeconds !== undefined || cleared.duration !== 0 || cleared.workoutId !== 'new') throw new Error('Seconds/move failed');
    if (!(await activeDb.workouts.get('old')).isDeleted || (await activeDb.workouts.get('new')).startTime !== '2026-01-02T21:30:00.000Z') throw new Error('Bounds failed');
    form.elements.typeId.value = 'strength'; await submit();
    const strength = await activeDb.logs.get('old');
    if (strength.duration !== undefined || strength.durationSeconds !== undefined || strength.weight !== 20 || strength.reps !== 5) throw new Error('Strength switch failed');
    form.elements.typeId.value = 'time'; await submit();
    const timed = await activeDb.logs.get('old');
    if (timed.weight !== undefined || timed.reps !== undefined) throw new Error('Time switch failed');
    const outbox = (await activeDb.dirtyEntities.toArray()).map(x => x.key).sort();
    storage.dispose();
    return { duration, viewerZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ownerZone: storage.getTimeZone(), outbox };
  }, compiled);
  assert.deepEqual(result.outbox, ['logs:old', 'workouts:new', 'workouts:old']);
  console.log(JSON.stringify({ browser: 'Chromium', ...result, secondsClear: true, categorySwitch: true, implicitMove: true }));
} finally { await browser?.close(); await server.close(); await rm(envDir, { recursive: true, force: true }); }
