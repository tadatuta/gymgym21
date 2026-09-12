import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { activateAccountDatabase, db } from '../db';
import { authorizedApiFetch } from '../auth';
import { SyncService } from './sync';
import type { SyncConflictRecord, WorkoutSet } from '../types';

vi.mock('../auth', () => ({ authorizedApiFetch: vi.fn() }));
const date = '2026-09-01T12:00:00Z';
const log = (id: string): WorkoutSet => ({ id, workoutTypeId: 'T', workoutId: 'W', date, updatedAt: date, reps: 5, weight: 20 });
const server = (id: string): WorkoutSet => ({ ...log(id), date: '2026-09-01T12:00:00.000Z', version: 42, isDeleted: false, serverUpdatedAt: date });
const conflict = (id: string): SyncConflictRecord => ({ key: `logs:${id}`, entityType: 'logs', entityId: id,
    reason: 'stale-version', serverVersion: 42, localPayload: log(id), serverPayload: server(id), createdAt: date });
beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    await activateAccountDatabase(`equivalent-${crypto.randomUUID()}`);
});

it('removes 768 redundant saved conflicts offline, preserves real conflicts and current outbox edits', async () => {
    const rows = Array.from({ length: 768 }, (_, i) => conflict(`L${i}`));
    const real = { ...conflict('real'), localPayload: { ...log('real'), reps: 6 } };
    const missing = { ...conflict('missing'), serverPayload: undefined };
    const deleted = { ...conflict('deleted'), serverPayload: { ...server('deleted'), isDeleted: true } };
    const wrongId = { ...conflict('wrong'), serverPayload: server('other') };
    await db.syncConflicts.bulkPut([...rows, real, missing, deleted, wrongId]);
    await db.logs.put({ ...server('L0'), reps: 99 });
    await SyncService.markDirty('logs', 'L0');
    const before = await db.dirtyEntities.toArray();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const service = new SyncService();
    await service.bootstrapDirtyState();
    expect((await db.syncConflicts.toArray()).map(x => x.key).sort()).toEqual(['logs:deleted', 'logs:missing', 'logs:real', 'logs:wrong']);
    expect(await db.logs.get('L0')).toMatchObject({ reps: 99, version: 42 });
    expect(await db.dirtyEntities.toArray()).toEqual(before);
    expect(service.cacheChanges.take().conflicts).toHaveLength(768);
    expect(authorizedApiFetch).not.toHaveBeenCalled();
    await service.bootstrapDirtyState();
    expect(service.cacheChanges.take().conflicts).toEqual([]);
});

it('clears equivalent receipt conflicts without losing a concurrent local edit or a different payload', async () => {
    await db.logs.bulkPut([log('same'), log('different')]);
    await SyncService.markDirtyMany(['same', 'different'].map(entityId => ({ entityType: 'logs', entityId })));
    vi.mocked(authorizedApiFetch).mockImplementation(async () => {
        await db.logs.update('same', { reps: 99 });
        await SyncService.markDirty('logs', 'same');
        return new Response(JSON.stringify({ protocolVersion: 1, cursor: 42, hasMore: false,
            changes: { logs: [server('same'), { ...server('different'), reps: 7 }] },
            conflicts: ['same', 'different'].map(entityId => ({ entityType: 'logs', entityId, reason: 'stale-version', serverVersion: 42 })),
            acknowledged: ['same', 'different'].map(entityId => ({ entityType: 'logs', entityId })),
        }), { status: 200 });
    });
    expect(await SyncService.sync()).toMatchObject({ conflicts: 1, hasMore: true });
    expect(await db.logs.get('same')).toMatchObject({ reps: 99, version: 42 });
    expect(await db.dirtyEntities.get('logs:same')).toBeDefined();
    expect(await db.syncConflicts.get('logs:same')).toBeUndefined();
    expect(await db.syncConflicts.get('logs:different')).toMatchObject({ localPayload: { reps: 5 }, serverPayload: { reps: 7 } });
});

it('does not silently rebase a different unsent edit when a pull arrives', async () => {
    await db.logs.bulkPut([log('same'), { ...log('different'), reps: 99 }]);
    vi.mocked(authorizedApiFetch).mockImplementation(async () => {
        await SyncService.markDirtyMany(['same', 'different'].map(entityId => ({ entityType: 'logs', entityId })));
        return new Response(JSON.stringify({ protocolVersion: 1, cursor: 42, hasMore: false,
            changes: { logs: [server('same'), server('different')] }, conflicts: [], acknowledged: [],
        }), { status: 200 });
    });
    await SyncService.sync();
    expect(await db.logs.get('same')).toMatchObject({ reps: 5, version: 42 });
    expect((await db.logs.get('different'))?.version).toBeUndefined();
    expect((await db.logs.get('different'))?.reps).toBe(99);
    expect(await db.dirtyEntities.count()).toBe(2);
});
