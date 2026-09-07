// Audit fixture: inspects production functions with a synthetic SQL adapter.
// Run after building the server: node audit/reproduce-server.mjs
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const base = fileURLToPath(new URL('../apps/server/dist/', import.meta.url));
let code = await fs.readFile(base + 'storage.js', 'utf8');
code = code.replace(/from '(\.\/[^']+)'/g, (_, p) => `from '${new URL(p, 'file://' + base).href}'`);
code += '\nexport { normalizeProfileForWrite, refreshPublicAliases, buildPublicProfile };\n';
await fs.writeFile('/tmp/gym21-audit-storage-internals.mjs', code);
const { normalizeProfileForWrite, refreshPublicAliases, buildPublicProfile } = await import('/tmp/gym21-audit-storage-internals.mjs');
const profile = normalizeProfileForWrite({ id: 'me', isPublic: true, createdAt: '2026-09-06T00:00:00Z', telegramUsername: 'victim_alias' }, { authContext: { kind: 'better-auth', storageKey: 'attacker', authUser: { username: 'attacker_alias' } } });
assert.equal(profile.telegramUsername, 'victim_alias');
const queries = [];
await refreshPublicAliases({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } }, 'attacker', profile);
const hijack = queries.find(q => q.params?.[0] === 'victim_alias');
assert.equal(hijack.params[2], 'attacker');
assert.match(hijack.sql, /storage_key = EXCLUDED.storage_key/);
console.log('CONFIRMED: unverified telegramUsername produces an alias upsert that overwrites the previous owner (captured SQL, no real DB)');
const logs = Array.from({ length: 20 }, (_, i) => ({ id: String(i), workoutTypeId: 't', workoutId: String(i), date: `2026-08-${String(i+1).padStart(2, '0')}T12:00:00Z`, weight: 10, reps: 1 }));
const payload = buildPublicProfile(profile, [{ id: 't', name: 'Type' }], logs, 'fallback');
assert.equal(payload.stats.totalWorkouts, 14);
assert.equal(payload.stats.totalVolume, 200);
console.log('CONFIRMED: public profile reports 14 workouts for 20 sessions, while volume includes all 20');
await refreshPublicAliases({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } }, 'u_uuid', { ...profile, telegramUserId: 12345 });
assert.equal(queries.some(q => q.params?.[0] === 'id_12345'), false);
console.log('CONFIRMED: public aliases omit the linked Telegram id_12345 alias');
