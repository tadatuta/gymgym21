import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncService } from '../services/sync';
import { StorageService } from './storage';

vi.mock('../auth', () => ({
    authorizedApiFetch: vi.fn(),
    clearAuthState: vi.fn(),
    getCurrentUser: vi.fn(() => null),
    hasActiveSession: vi.fn(() => true),
    resolveApiUrl: vi.fn((path = '') => path)
}));

describe('StorageService sync scheduling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });

    it('batches repeated scheduleSync calls into one sync execution', async () => {
        const syncSpy = vi.spyOn(SyncService, 'sync').mockResolvedValue({
            revision: 1,
            conflicts: 0,
            pushedEntities: 1,
            pulledEntities: 1
        });

        const storage = new StorageService({ autoInit: false, syncDebounceMs: 50 });
        vi.spyOn(storage, 'reloadCache').mockResolvedValue();

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
                revision: 2,
                conflicts: 0,
                pushedEntities: 1,
                pulledEntities: 1
            });
        }));

        const storage = new StorageService({ autoInit: false, syncDebounceMs: 10 });
        vi.spyOn(storage, 'reloadCache').mockResolvedValue();

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
});
