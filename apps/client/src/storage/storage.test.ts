import { SyncError } from '../services/sync-error';
import { invalidBackupCases, validBackupData } from './backup-fixtures.test-helper';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { authorizedApiFetch } from '../auth';
import { SyncService } from '../services/sync';
import { StorageService } from './storage';

vi.mock('../auth', () => ({
    authorizedApiFetch: vi.fn(),
    clearAuthState: vi.fn(),
    getCurrentUser: vi.fn(() => null),
    hasActiveSession: vi.fn(() => true),
    hasVerifiedOnlineAccount: vi.fn(() => true),
    resolveApiUrl: vi.fn((path = '') => path)
}));

describe('StorageService sync scheduling', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        const values = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
            clear: () => values.clear(),
        });
    });

    afterEach(() => {
        if (vi.isFakeTimers()) {
            vi.runOnlyPendingTimers();
        }
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('automatically schedules remaining real outbox batches without another user flush', async () => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
        const service = new StorageService({ autoInit: false, enableBroadcast: false, syncDebounceMs: 0 });
        try {
            await service.activate(`real-batches-${Math.random()}`);
            await db.workoutTypes.put({ id: 'T', name: 'Existing', updatedAt: '2026-09-01T00:00:00Z', version: 1 });
            const logs = Array.from({ length: 501 }, (_, i) => ({ id: `L${i}`, workoutTypeId: 'T', workoutId: 'W', date: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }));
            await db.logs.bulkPut(logs);
            await SyncService.markDirtyMany(logs.map(({ id }) => ({ entityType: 'logs', entityId: id })));
            let requests = 0;
            vi.mocked(authorizedApiFetch).mockImplementation(async (_url, init) => {
                requests++;
                const sent = JSON.parse(String(init?.body));
                return new Response(JSON.stringify({ cursor: requests, changes: sent.changes, conflicts: [], hasMore: false }), { status: 200 });
            });
            await service.sync();
            await vi.waitFor(async () => expect(await db.dirtyEntities.count()).toBe(0), { timeout: 30000, interval: 100 });
            expect(requests).toBe(2);
        } finally { service.dispose(); }
    }, 30000);

    it('does not notify for unchanged or transport-only cache reloads; retains identity, domain and conflict changes', async () => {
        const service = new StorageService({ enableBroadcast: false });
        try {
            await service.activate(`cache-drafts-${Math.random()}`);
            await service.addWorkoutType('Original');
            const updated = vi.fn();
            service.onUpdate(updated);
            await service.reloadCache(); await service.reloadCache();
            expect(updated).not.toHaveBeenCalled();
            const type = service.getWorkoutTypes()[0];
            await db.workoutTypes.update(type.id, { version: 9, updatedAt: 'new', serverUpdatedAt: 'server' });
            await service.reloadCache();
            expect(updated).not.toHaveBeenCalled();
            expect(service.getWorkoutTypes()[0].version).toBe(9);
            await db.workoutTypes.update(type.id, { name: 'Remote' }); await service.reloadCache();
            expect(updated).toHaveBeenCalledTimes(1);
            await db.profile.put({ id: 'me', isPublic: false, createdAt: 'old', updatedAt: 'old', telegramUserId: 123 });
            await service.reloadCache();
            await db.profile.update('me', { telegramUserId: 456 }); await service.reloadCache();
            expect(updated).toHaveBeenCalledTimes(3);
            await db.syncConflicts.put({ key: 'workoutTypes:test', entityType: 'workoutTypes', entityId: type.id,
                reason: 'stale-version', serverVersion: 9, createdAt: 'now' });
            await service.reloadCache();
            await db.syncConflicts.update('workoutTypes:test', { serverVersion: 10 }); await service.reloadCache();
            expect(updated).toHaveBeenCalledTimes(5);
            await service.reloadCache(); expect(updated).toHaveBeenCalledTimes(5);
        } finally { service.dispose(); }
    });

    it('notifies when the account changes even for identical empty data', async () => {
        const service = new StorageService({ enableBroadcast: false });
        try {
            await service.activate(`empty-A-${Math.random()}`);
            const updated = vi.fn(); service.onUpdate(updated);
            await service.activate(`empty-B-${Math.random()}`);
            expect(updated).toHaveBeenCalledTimes(1);
        } finally { service.dispose(); }
    });

    it('rejects the entire file before online preflight or any IndexedDB table mutation in both modes', async () => {
        const service = new StorageService({ enableBroadcast: false });
        try {
            await service.activate(`invalid-backup-${Math.random()}`);
            await service.addWorkoutType('Keep');
            await db.aiResultCache.put({ type: 'general', markdown: 'cached', updatedAt: '2026-09-01T00:00:00Z' });
            const before = await Promise.all(db.tables.map((table) => table.toArray()));
            const preflight = vi.spyOn(SyncService.prototype, 'importBackup');
            for (const online of [true, false]) {
                Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
                for (const mode of ['merge', 'replace'] as const) {
                    for (const [path, input] of invalidBackupCases) {
                        await expect(service.importData(input, mode)).rejects.toThrow(path);
                        expect(await Promise.all(db.tables.map((table) => table.toArray()))).toEqual(before);
                    }
                }
            }
            expect(preflight).not.toHaveBeenCalled();
        } finally {
            service.dispose();
            Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
        }
    });

    it('valid envelope reaches the same preflight in merge and replace modes', async () => {
        const service = new StorageService({ enableBroadcast: false });
        try {
            await service.activate(`valid-backup-${Math.random()}`);
            const preflight = vi.spyOn(SyncService.prototype, 'importBackup').mockResolvedValue(undefined);
            for (const mode of ['merge', 'replace'] as const) {
                await service.importData({ format: 'gym21-backup', version: 1, exportedAt: '2026-09-01T00:00:00Z', data: validBackupData() }, mode);
                expect(preflight).toHaveBeenLastCalledWith(expect.objectContaining({ logs: validBackupData().logs.map((log) => expect.objectContaining(log)) }), mode);
            }
        } finally { service.dispose(); }
    });

    it('offline merge rebases on local versions, keeps other records, and offline replace is non-destructive', async () => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
        const service = new StorageService({ enableBroadcast: false });
        try {
            await service.activate(`offline-backup-${Math.random()}`);
            await db.workoutTypes.clear();
            await db.dirtyEntities.clear();
            await db.workoutTypes.bulkPut([
                { id: 'A', name: 'original', version: 7, updatedAt: 'old' },
                { id: 'B', name: 'keep', version: 8, updatedAt: 'old' },
            ]);
            const input = { workoutTypes: [{ id: 'A', name: 'modified', version: 99999 }], logs: [], workouts: [] };
            await service.importData(input, 'merge');
            expect(await db.workoutTypes.get('A')).toMatchObject({ name: 'modified', version: 7 });
            expect(await db.workoutTypes.get('B')).toMatchObject({ name: 'keep', version: 8 });
            expect(await db.dirtyEntities.get('workoutTypes:A')).toBeDefined();
            const before = await db.workoutTypes.toArray();
            await expect(service.importData(input, 'replace')).rejects.toThrow('подключения');
            expect(await db.workoutTypes.toArray()).toEqual(before);
        } finally {
            service.dispose();
            Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
        }
    });

    it('refreshes cache after a failed online import preflight and releases the sync guard', async () => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
        const service = new StorageService({ enableBroadcast: false });
        try {
            await service.activate(`failed-backup-${Math.random()}`);
            const reload = vi.spyOn(service, 'reloadCache');
            vi.spyOn(SyncService.prototype, 'importBackup').mockRejectedValue(new Error('revision conflict'));
            await expect(service.importData({ workoutTypes: [], workouts: [], logs: [] }, 'replace')).rejects.toThrow('revision conflict');
            expect(reload).toHaveBeenCalled();
            await expect(service.importData({ workoutTypes: [], workouts: [], logs: [] }, 'replace')).rejects.toThrow('revision conflict');
        } finally {
            service.dispose();
        }
    });

    it('honors Retry-After across manual scheduling, resets on success, cancels on dispose', async () => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
        const spy = vi.spyOn(SyncService, 'sync').mockRejectedValueOnce(new SyncError('busy', 'ROUTE_BUSY', true, 60000))
            .mockResolvedValue({ cursor: 1, conflicts: 0, pushedEntities: 0, pulledEntities: 0, hasMore: false });
        const service = new StorageService({ enableBroadcast: false });
        await service.activate(`recovery-${Math.random()}`);
        await db.workoutTypes.put({ id: 'existing', name: 'Existing', updatedAt: new Date().toISOString() });
        vi.spyOn(service, 'reloadCache').mockResolvedValue();
        vi.useFakeTimers();
        await service.sync();
        service.scheduleSync(0);
        await service.sync();
        await vi.advanceTimersByTimeAsync(59999);
        expect(spy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(service.getSyncState()).toMatchObject({ retryAt: 0, error: undefined });
        spy.mockRejectedValue(new SyncError('invalid', 'INVALID_RECORD'));
        await service.sync();
        await vi.advanceTimersByTimeAsync(120000);
        expect(spy).toHaveBeenCalledTimes(3);
        spy.mockRejectedValue(new SyncError('busy', 'ROUTE_BUSY', true));
        await service.sync();
        service.dispose();
        await vi.advanceTimersByTimeAsync(120000);
        expect(spy).toHaveBeenCalledTimes(4);
    });

    it('batches repeated scheduleSync calls into one sync execution', async () => {
        const syncSpy = vi.spyOn(SyncService, 'sync').mockResolvedValue({
            cursor: 1,
            conflicts: 0,
            pushedEntities: 1,
            pulledEntities: 1,
            hasMore: false
        });

        const storage = new StorageService({ autoInit: false, syncDebounceMs: 50, enableBroadcast: false });
        await storage.activate('sync-scheduling-test');
        await db.workoutTypes.put({ id: 'existing', name: 'Existing', updatedAt: new Date().toISOString() });
        vi.spyOn(storage, 'reloadCache').mockResolvedValue();
        vi.useFakeTimers();

        storage.scheduleSync();
        storage.scheduleSync();
        storage.scheduleSync();

        expect(syncSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(60);

        expect(syncSpy).toHaveBeenCalledTimes(1);
    });

    it('queues a follow-up sync when a new flush is requested while one is in flight', async () => {
        let resolveSync: (() => void) | undefined;
        const syncSpy = vi.spyOn(SyncService, 'sync').mockImplementation(() => new Promise((resolve) => {
            resolveSync = () => resolve({
                cursor: 2,
                conflicts: 0,
                pushedEntities: 1,
                pulledEntities: 1,
                hasMore: false
            });
        }));

        const storage = new StorageService({ autoInit: false, syncDebounceMs: 10, enableBroadcast: false });
        await storage.activate('sync-scheduling-test');
        await db.workoutTypes.put({ id: 'existing', name: 'Existing', updatedAt: new Date().toISOString() });
        vi.spyOn(storage, 'reloadCache').mockResolvedValue();
        vi.useFakeTimers();

        storage.scheduleSync();
        await vi.advanceTimersByTimeAsync(15);
        expect(syncSpy).toHaveBeenCalledTimes(1);

        storage.scheduleSync(0);
        expect(syncSpy).toHaveBeenCalledTimes(1);

        resolveSync?.();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);

        expect(syncSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps account databases isolated and writes entity plus outbox together', async () => {
        const storage = new StorageService({
            autoInit: false,
            syncDebounceMs: 60_000,
            enableBroadcast: false,
        });
        const suffix = Math.random().toString(36).slice(2);
        const firstAccount = `account-a-${suffix}`;
        const secondAccount = `account-b-${suffix}`;

        await storage.activate(firstAccount);
        const created = await storage.addWorkoutType('Тестовое упражнение');
        const dirty = await db.dirtyEntities.get(`workoutTypes:${created.id}`);

        expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(await db.workoutTypes.get(created.id)).toEqual(created);
        expect(dirty?.generation).toBeTruthy();

        await storage.activate(secondAccount);
        expect(storage.getWorkoutTypes()).toEqual([]);

        await storage.activate(firstAccount);
        expect(storage.getWorkoutTypes().map((entry) => entry.id)).toContain(created.id);
        storage.dispose();
    });

    it('assigns legacy localStorage data to only the first activated account', async () => {
        const storage = new StorageService({ autoInit: false, enableBroadcast: false });
        const suffix = Math.random().toString(36).slice(2);
        const firstAccount = `legacy-a-${suffix}`;
        const secondAccount = `legacy-b-${suffix}`;
        localStorage.setItem('gym_twa_data', JSON.stringify({
            workoutTypes: [{
                id: 'legacy-bench',
                name: 'Legacy bench',
                order: 1,
                updatedAt: new Date().toISOString(),
            }],
            logs: [],
            workouts: [],
        }));

        await storage.activate(firstAccount);
        expect(storage.getWorkoutTypes().map((entry) => entry.id)).toContain('legacy-bench');

        await storage.activate(secondAccount);
        expect(storage.getWorkoutTypes()).toEqual([]);
        storage.dispose();
    });

    it('uses an account-scoped public profile cache when the network is unavailable', async () => {
        const storage = new StorageService({ autoInit: false, enableBroadcast: false });
        const suffix = Math.random().toString(36).slice(2);
        const firstAccount = `profile-cache-a-${suffix}`;
        const secondAccount = `profile-cache-b-${suffix}`;
        const payload = {
            displayName: 'Cached User',
            identifier: 'cached_user',
            stats: { totalWorkouts: 1, totalVolume: 100 },
            recentActivity: [],
        };

        await storage.activate(firstAccount);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })));
        const fresh = await storage.getPublicProfile('cached_user');
        expect(fresh?.cacheMetadata?.cached).toBe(false);

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
        const cached = await storage.getPublicProfile('cached_user');
        expect(cached?.displayName).toBe('Cached User');
        expect(cached?.cacheMetadata?.cached).toBe(true);

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
        expect(await storage.getPublicProfile('cached_user')).toBeNull();

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
        expect(await storage.getPublicProfile('cached_user')).toBeNull();

        await storage.activate(secondAccount);
        expect(await storage.getPublicProfile('cached_user')).toBeNull();
        storage.dispose();
    });
});

it.each(['ai', 'public'] as const)('discards delayed %s cache response after account switch', async (kind) => {
    const { authorizedApiFetch } = await import('../auth');
    const storage = new StorageService({ enableBroadcast: false });
    await storage.activate(`cache-a-${Math.random()}`);
    const a = db;
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(authorizedApiFetch).mockImplementation(fetchMock);
    const pending = kind === 'ai' ? storage.getAIRecommendation('general') : storage.getPublicProfile('someone');
    const rejected = expect(pending).rejects.toThrow('Stale account operation');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await storage.activate(`cache-b-${Math.random()}`);
    finish(new Response(JSON.stringify(kind === 'ai' ? { format: 'markdown', recommendation: 'A advice' } : { username: 'someone' })));
    await rejected;
    expect(await db.aiResultCache.count()).toBe(0);
    expect(await db.publicProfileCache.count()).toBe(0);
    await a.open();
    expect(await a.aiResultCache.count()).toBe(0);
    expect(await a.publicProfileCache.count()).toBe(0);
    a.close();
    storage.dispose();
    vi.unstubAllGlobals();
});
