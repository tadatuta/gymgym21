import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
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
