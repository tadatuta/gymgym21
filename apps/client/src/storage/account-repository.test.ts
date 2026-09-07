import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GymDatabase, db } from '../db';
import { SyncService } from '../services/sync';
import { AccountRepository } from './account-repository';
import { AccountReads } from './account-reads';
import { DomainMutations } from './domain-mutations';
import { StorageService } from './storage';

vi.mock('../auth', () => ({
    authorizedApiFetch: vi.fn(), getCurrentUser: () => null,
    hasVerifiedOnlineAccount: () => false, resolveApiUrl: (path: string) => path,
}));
const services: StorageService[] = [];
const databases: GymDatabase[] = [];
const stamp = '2026-09-01T00:00:00Z';
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
async function service() {
    const value = new StorageService({ enableBroadcast: false });
    services.push(value);
    await value.activate(`repository-a-${crypto.randomUUID()}`);
    return value;
}
beforeEach(() => localStorage.clear());
afterEach(async () => {
    services.forEach(value => value.dispose()); services.length = 0;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    await Promise.all(databases.splice(0).map(database => database.delete()));
});

describe('account repository ownership and atomic writes', () => {
    it('binds a pending mutation before its transaction starts and rejects after account switch', async () => {
        const storage = await service();
        const name = db.name;
        const entered = deferred(); const resume = deferred();
        const transaction = AccountRepository.prototype.transaction;
        vi.spyOn(AccountRepository.prototype, 'transaction').mockImplementationOnce(async function (this: AccountRepository, tables, operation) {
            entered.resolve(); await resume.promise;
            return transaction.call(this, tables, operation);
        });
        const pending = storage.addLog({ workoutTypeId: 'T' }).then(() => null, error => error);
        await entered.promise;
        await storage.activate(`repository-b-${crypto.randomUUID()}`);
        const update = vi.fn(); const status = vi.fn();
        storage.onUpdate(update); storage.onSyncStatusChange(status);
        resume.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(await db.logs.count()).toBe(0); expect(await db.workouts.count()).toBe(0);
        expect(await db.dirtyEntities.count()).toBe(0);
        const first = new GymDatabase(name); databases.push(first);
        expect(await first.logs.count()).toBe(0); expect(await first.workouts.count()).toBe(0);
        expect(await first.dirtyEntities.count()).toBe(0);
        expect(update).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
    });

    it('rolls back domain writes and a written outbox generation when switching mid-transaction', async () => {
        const storage = await service();
        const name = db.name;
        const entered = deferred(); const resume = deferred();
        const markDirty = SyncService.prototype.markDirtyMany;
        vi.spyOn(SyncService.prototype, 'markDirtyMany').mockImplementationOnce(async function (this: SyncService, changes) {
            await markDirty.call(this, changes);
            entered.resolve();
            await Dexie.waitFor(resume.promise);
        });
        const pending = storage.addLog({ workoutTypeId: 'T' }).then(() => null, error => error);
        await entered.promise;
        await storage.activate(`repository-b-${crypto.randomUUID()}`);
        const update = vi.fn(); const status = vi.fn();
        storage.onUpdate(update); storage.onSyncStatusChange(status);
        resume.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(await db.logs.count()).toBe(0); expect(await db.workouts.count()).toBe(0);
        expect(await db.dirtyEntities.count()).toBe(0);
        const first = new GymDatabase(name); databases.push(first);
        expect(await first.logs.count()).toBe(0); expect(await first.workouts.count()).toBe(0);
        expect(await first.dirtyEntities.count()).toBe(0);
        expect(update).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
    });

    it('rolls back domain data on an actual IndexedDB outbox constraint failure', async () => {
        const storage = await service();
        const notify = vi.fn(); storage.onUpdate(notify);
        // Invalid key reaches fake IndexedDB from the real outbox method, after domain writes.
        const bulkPut = db.dirtyEntities.bulkPut.bind(db.dirtyEntities);
        vi.spyOn(db.dirtyEntities, 'bulkPut').mockImplementationOnce(records =>
            bulkPut(records.map(record => ({ ...record, key: undefined as unknown as string }))));
        await expect(storage.addLog({ workoutTypeId: 'T' })).rejects.toThrow();
        expect(await db.logs.count()).toBe(0); expect(await db.workouts.count()).toBe(0);
        expect(await db.dirtyEntities.count()).toBe(0); expect(notify).not.toHaveBeenCalled();
    });

    it('allows explicitly independent repositories without consulting the active global database', async () => {
        const make = () => {
            const database = new GymDatabase(`repository-independent-${crypto.randomUUID()}`); databases.push(database);
            const repository = new AccountRepository({ database, storageKey: database.name, signal: new AbortController().signal,
                isCurrent: () => true, assertCurrent() {} });
            const reads = new AccountReads(repository, () => {});
            return { database, repository, mutations: new DomainMutations(repository, reads, () => reads.reload()) };
        };
        const a = make(); const b = make();
        const [first, second] = await Promise.all([a.mutations.addWorkoutType('A'), b.mutations.addWorkoutType('B')]);
        expect((await a.database.workoutTypes.toArray()).map(row => row.id)).toEqual([first.id]);
        expect((await b.database.workoutTypes.toArray()).map(row => row.id)).toEqual([second.id]);
        const initial = (await a.database.dirtyEntities.toArray())[0].generation;
        await a.mutations.updateWorkoutType(first.id, 'A updated');
        expect((await a.database.dirtyEntities.toArray())[0].generation).not.toBe(initial);
        expect((await b.database.dirtyEntities.toArray()).map(row => row.entityId)).toEqual([second.id]);
        a.repository.dispose(); b.repository.dispose();
    });

    it('suppresses stale conflict continuation and cache getters on an older facade', async () => {
        const first = await service(); const name = db.name;
        const localPayload = { id: 'L', workoutTypeId: 'T', workoutId: 'W', date: stamp, updatedAt: stamp };
        await db.syncConflicts.put({ key: 'logs:L', entityType: 'logs', entityId: 'L', createdAt: stamp, reason: 'stale-version',
            serverVersion: 2, localPayload });
        await first.addWorkoutType('A only');
        const entered = deferred(); const resume = deferred();
        const get = db.syncConflicts.get.bind(db.syncConflicts);
        vi.spyOn(db.syncConflicts, 'get').mockImplementationOnce(key => Dexie.Promise.resolve(get(key)).then(async conflict => {
            entered.resolve(); await resume.promise; return conflict;
        }));
        const pending = first.restoreConflictLocal('logs:L').then(() => null, error => error);
        await entered.promise;
        const second = await service();
        resume.resolve(); expect(await pending).toBeInstanceOf(Error);
        expect(first.isActive()).toBe(false); expect(first.getWorkoutTypes()).toEqual([]);
        expect(first.getStorageKey()).toBeNull(); expect(second.getLogs()).toEqual([]);
        expect(await db.syncConflicts.count()).toBe(0); expect(await db.logs.count()).toBe(0);
        const original = new GymDatabase(name); databases.push(original);
        expect(await original.syncConflicts.count()).toBe(1); expect(await original.logs.count()).toBe(0);
    });

    it('aborts and rejects owned public reads on dispose without touching another account cache', async () => {
        const storage = await service(); const name = db.name;
        let signal: AbortSignal | undefined; const resume = deferred();
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
            signal = init.signal; await resume.promise;
            return new Response(JSON.stringify({ identifier: 'friend', displayName: 'Friend' }));
        }));
        const pending = storage.getPublicProfile('friend').then(() => null, error => error);
        expect(signal?.aborted).toBe(false);
        storage.dispose(); expect(signal?.aborted).toBe(true);
        await service(); resume.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(await db.publicProfileCache.count()).toBe(0);
        const original = new GymDatabase(name); databases.push(original);
        expect(await original.publicProfileCache.count()).toBe(0);
    });
});
