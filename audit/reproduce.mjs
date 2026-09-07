// Audit fixture: confirms current defects using synthetic data; never connects to a real database.
// Run from the repository after building the server: node audit/reproduce.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const require = createRequire(root + '/package.json');
const { build } = require('esbuild');
require('fake-indexeddb/auto');
const values = new Map();
globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
globalThis.CustomEvent ??= class extends Event { constructor(name, options) { super(name); this.detail = options?.detail; } };
await build({
  stdin: { contents: `export * from './apps/client/src/services/sync.ts'; export * from './apps/client/src/db.ts'; export { StorageService } from './apps/client/src/storage/storage.ts'; export * from './apps/client/src/components/stats/Charts.ts'; export * from './apps/client/src/utils/export.ts';`, resolveDir: root },
  outfile: '/tmp/gym21-audit-client.mjs', bundle: true, platform: 'node', format: 'esm',
  plugins: [{ name: 'auth-fixture', setup(b) { b.onResolve({ filter: /(^|\/)auth$/ }, () => ({ path: 'auth', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const authorizedApiFetch = (...args) => globalThis.auditFetch(...args); export const clearAuthState = () => {}; export const getCurrentUser = () => null; export const hasVerifiedOnlineAccount = () => false; export const resolveApiUrl = x => x;` })); } }],
});
const c = await import('/tmp/gym21-audit-client.mjs');
await c.activateAccountDatabase('audit-A');
const requests = [];
globalThis.auditFetch = async (_, opts) => { requests.push(JSON.parse(opts.body)); return Response.json({ cursor: 0, changes: {}, acknowledged: [], conflicts: [] }); };
await c.SyncService.sync();
await c.SyncService.sync();
assert.equal(requests[0].batchId, requests[1].batchId);
console.log('CONFIRMED: independent empty pulls reuse the same batchId');

let finish;
let started;
const ready = new Promise(r => started = r);
globalThis.auditFetch = async () => { started(); return new Promise(r => finish = r); };
const syncing = c.SyncService.sync();
await ready;
await c.activateAccountDatabase('audit-B');
finish(Response.json({ cursor: 1, changes: { workoutTypes: [{ id: 'private-A', name: 'Account A data', updatedAt: '2026-09-06T00:00:00Z', version: 1 }] }, conflicts: [], acknowledged: [] }));
await syncing;
assert.equal((await c.db.workoutTypes.get('private-A')).name, 'Account A data');
console.log('CONFIRMED: a late account A response is written into active account B database');

const service = new c.StorageService({ enableBroadcast: false });
await service.activate('audit-import');
await service.importData({ workouts: [], workoutTypes: [{ id: 't', name: 'Type', updatedAt: '2026-09-06T00:00:00Z' }], logs: [{ id: 'l', workoutTypeId: 't', workoutId: 'w', date: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', weight: '<b data-audit>not a number</b>', reps: 1 }] });
assert.equal(typeof (await c.db.logs.get('l')).weight, 'string');
console.log('CONFIRMED: JSON import accepts HTML strings in numeric fields');
await service.importData({ workouts: [], workoutTypes: [], logs: [
  { id: 'z-old', workoutId: '', workoutTypeId: 't', date: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'a-new', workoutId: '', workoutTypeId: 't', date: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' },
] });
assert.equal(service.getLogs().at(-1).id, 'z-old');
console.log('CONFIRMED: getLogs().at(-1) selects by primary key, not latest date');
const markdown = c.generateMarkdown(await service.exportData());
assert.equal(markdown.includes('Неизвестное упражнение'), false);
console.log('CONFIRMED: Markdown export omits logs without workoutId');
const chart = c.renderVolumeChart(service.getLogs());
assert.equal(chart.includes('NaN'), true);
console.log('CONFIRMED: zero-volume chart generates NaN SVG coordinates');
service.dispose();
c.closeActiveDatabase();

await build({ entryPoints: [root + '/apps/client/src/auth.ts'], outfile: '/tmp/gym21-audit-auth.mjs', bundle: true, platform: 'node', format: 'esm', define: { 'import.meta.env': '{}' }, plugins: [{ name: 'auth-library-fixture', setup(b) { b.onResolve({ filter: /^(@better-auth\/passkey\/client|better-auth\/client)$/ }, args => ({ path: args.path, namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const passkeyClient = () => ({}); export const createAuthClient = () => ({ signOut: async () => ({ data: null, error: { status: 503, message: 'Unavailable' } }), getSession: async () => ({ data: null, error: null }) });` })); } }] });
const a = await import('/tmp/gym21-audit-auth.mjs');
await a.signOut();
assert.equal(localStorage.getItem('gym21_pending_sign_out_v1'), null);
console.log('CONFIRMED: resolved signOut error does not mark pending sign-out');

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
const database = await import(pathToFileURL(root + '/apps/server/dist/database.js'));
const pool = database.getDatabasePool();
let revision = 0;
const receipts = new Map();
let changedReads = 0;
const query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  if (q.startsWith('SELECT name FROM app_migrations')) return { rows: [{ name: '001_storage_runtime.sql' }, { name: '002_sync_receipts.sql' }] };
  if (q.startsWith('SELECT server_revision')) return { rows: [{ server_revision: revision }] };
  if (q.startsWith('SELECT response_payload')) return { rows: receipts.has(params[1]) ? [{ response_payload: receipts.get(params[1]) }] : [] };
  if (q.startsWith('INSERT INTO storage_sync_receipts')) receipts.set(params[1], JSON.parse(params[2]));
  if (q.startsWith('SELECT entity_type')) { changedReads++; return { rows: [] }; }
  return { rows: [] };
};
pool.query = query;
pool.connect = async () => ({ query, release() {} });
const { defaultStorageRepository: repo } = await import(pathToFileURL(root + '/apps/server/dist/storage.js'));
const request = { cursor: 0, batchId: requests[0].batchId, changes: {}, limit: 1000 };
await repo.sync('audit', request, { kind: 'better-auth', storageKey: 'audit' });
revision = 1;
const response = await repo.sync('audit', request, { kind: 'better-auth', storageKey: 'audit' });
assert.equal(response.cursor, 0);
assert.equal(changedReads, 1);
console.log('CONFIRMED: real server repository replays cursor 0 after revision becomes 1; fresh pull SQL is skipped (fake SQL adapter)');
await database.closeDatabasePool();
