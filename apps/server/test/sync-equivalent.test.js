import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';

const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `equivalent_${randomUUID().replaceAll('-', '')}`;
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.BETTER_AUTH_SECRET = 'equivalent-sync-test-secret-at-least-32';
delete process.env.DATABASE_URL;
let admin;
if (testUrl) {
    admin = new Pool({ connectionString: testUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(testUrl); url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
}
const { defaultStorageRepository: repository } = await import('../dist/storage.js');
const { closeDatabasePool } = await import('../dist/database.js');
test('legacy stale-but-equal push is acknowledged without writes; real differences and tombstones still conflict', { skip: !testUrl }, async () => {
    try {
        const date = '2026-09-01T12:00:00Z';
        const data = { workoutTypes: [{ id: 'T', name: 'Time' }],
            workouts: [{ id: 'W', startTime: date, status: 'finished', isManual: false, pauseIntervals: [] }],
            logs: [{ id: 'L', workoutTypeId: 'T', date, reps: 5 }],
            profile: { id: 'me', isPublic: false, createdAt: date } };
        await repository.replaceSnapshot('owner', data);
        const before = await repository.readSnapshot('owner');
        const context = { kind: 'better-auth', storageKey: 'owner', authUser: { id: 'owner', username: null } };
        const push = (batchId, changes) => repository.sync('owner', { protocolVersion: 1, batchId, cursor: before.revision, changes }, context);
        const result = await push('legacy-equal', data);
        assert.deepEqual(result.conflicts, []);
        assert.equal(result.acknowledged.length, 4);
        assert.equal(result.cursor, before.revision);
        assert.equal(result.changes.logs[0].version, before.logs[0].version);
        assert.deepEqual(await repository.readSnapshot('owner'), before);
        assert.deepEqual((await push('legacy-equal', data)).conflicts, []);
        const changed = await push('changed', { logs: [{ ...data.logs[0], reps: 6 }], profile: { ...data.profile, isPublic: true } });
        assert.deepEqual(changed.conflicts.map(x => x.entityType).sort(), ['logs', 'profile']);
        const deleted = await push('deleted', { logs: [{ ...data.logs[0], isDeleted: true }] });
        assert.equal(deleted.conflicts.length, 1);
        assert.deepEqual(await repository.readSnapshot('owner'), before);
    } finally {
        await closeDatabasePool();
        if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
    }
});
