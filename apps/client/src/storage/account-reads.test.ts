import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateAccountDatabase, closeActiveDatabase } from '../db';
import { AccountRepository } from './account-repository';
import { AccountReads } from './account-reads';
import { DomainMutations } from './domain-mutations';
import { SyncCoordinator } from './sync-coordinator';
import { getLatestLog } from '../utils/latest-log';
import { LatestLogIndex } from './latest-log-index';
import type { WorkoutSet } from '../types';
vi.mock('../auth', () => ({ getCurrentUser: () => null, hasVerifiedOnlineAccount: () => false, authorizedApiFetch: vi.fn() }));
const repositories: AccountRepository[] = [];
const stamp = '2026-09-01T00:00:00Z';
const log = (id: string, date = stamp): WorkoutSet => ({id, date, workoutTypeId: 'T', workoutId: 'W', updatedAt: stamp, reps: 1});
async function fixture() {
    await activateAccountDatabase(`incremental-${crypto.randomUUID()}`);
    const repository = new AccountRepository(); repositories.push(repository);
    const notify = vi.fn();
    const reads = new AccountReads(repository, notify);
    await repository.database.profile.put({id: 'me', isPublic: false, createdAt: stamp, timeZone: 'UTC', updatedAt: stamp});
    await reads.reload(); notify.mockClear();
    const mutations = new DomainMutations(repository, reads, async () => { await reads.flush(); });
    return {repository, reads, mutations, notify, db: repository.database};
}
afterEach(() => { repositories.splice(0).forEach(item => item.dispose()); closeActiveDatabase(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('incremental account cache', () => {
    it('ordinary mutations read only their IDs, expose domain composition and keep metadata without rerendering', async () => {
        const {repository, reads, mutations, notify, db} = await fixture();
        await db.logs.bulkPut(Array.from({length: 1000}, (_, i) => log(`L${i}`)));
        await reads.reload(); notify.mockClear();
        const full = vi.spyOn(repository.sync, 'readAll');
        const bulk = vi.spyOn(db.logs, 'bulkGet');
        await mutations.updateLog({...log('L1'), reps: 3});
        expect(full).not.toHaveBeenCalled(); expect(bulk).toHaveBeenCalledExactlyOnceWith(['L1']);
        expect(notify).toHaveBeenLastCalledWith(true, true, {entities: [{entityType: 'logs', entityId: 'L1'}], conflicts: []});
        await db.logs.update('L1', {version: 9, updatedAt: '2027-01-01T00:00:00Z', serverUpdatedAt: stamp});
        repository.sync.recordCacheChanges({entities: [{entityType: 'logs', entityId: 'L1'}], conflicts: []});
        await reads.flush();
        expect(reads.getLogById('L1')).toMatchObject({reps: 3, version: 9});
        expect(notify).toHaveBeenLastCalledWith(false, false, {entities: [], conflicts: []});
        await mutations.deleteLog('L1');
        expect(reads.getLogById('L1')).toBeUndefined();
        expect(reads.getLogs()).toHaveLength(999);
        expect(full).not.toHaveBeenCalled();
    });
    it('moves day/workout indexes, retains orphans, rebuilds the owner zone and preserves array ownership', async () => {
        const {repository, reads, mutations, db} = await fixture();
        await db.logs.bulkPut([log('night', '2026-01-01T22:30:00Z'), {...log('orphan'), workoutId: '', durationSeconds: 12}]);
        await reads.reload();
        expect(reads.getLogsInDayRange('2026-01-01','2026-01-01').map(x => x.id)).toEqual(['night']);
        await mutations.updateProfileSettings({timeZone: 'Europe/Moscow'});
        expect(reads.getLogsInDayRange('2026-01-02','2026-01-02').map(x => x.id)).toEqual(['night']);
        await mutations.updateLog({...reads.getLogById('night')!, date: '2026-09-01T00:00:00Z', workoutId: 'changed', durationSeconds: 30});
        expect(reads.getLogsInDayRange('2026-01-02','2026-01-02')).toEqual([]);
        expect(reads.getWorkoutDuration(reads.getWorkoutById(reads.getLogById('night')!.workoutId!)!)).toBe(0.5);
        expect(reads.getLogsInDayRange('2026-09-01','2026-09-01')).toHaveLength(2);
        const copy = reads.getLogs(); copy.splice(0);
        expect(reads.getLogs()).toHaveLength(2);
        await db.logs.delete('night'); repository.sync.recordCacheChanges({entities: [{entityType:'logs',entityId:'night'}],conflicts:[]});
        await reads.flush(); expect(reads.getLatestLog()?.id).toBe('orphan');
        await db.logs.clear(); await reads.reload(); expect(reads.getLatestLog()).toBeUndefined();
    });
    it('uses indexed day candidates with offset timestamps and stable implicit-session ID selection', async () => {
        const {reads, mutations, db} = await fixture();
        vi.useFakeTimers({toFake: ['Date']});
        vi.setSystemTime(new Date('2026-01-02T00:30:00Z'));
        try {
            await db.workouts.bulkPut([
                {id:'B', startTime:'2026-01-01T10:30:00-14:00', status:'finished', isManual:false, pauseIntervals:[], updatedAt:stamp},
                {id:'A', startTime:'2026-01-02T14:30:00+14:00', status:'finished', isManual:false, pauseIntervals:[], updatedAt:stamp},
                {id:'0-outside', startTime:'2026-01-02T00:00:00+14:00', status:'finished', isManual:false, pauseIntervals:[], updatedAt:stamp},
            ]);
            await reads.reload();
            const full = vi.spyOn(db.workouts,'toArray');
            expect((await mutations.addLog({workoutTypeId:'T', reps:1})).workoutId).toBe('A');
            expect(full).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });
    it('retains committed IDs across a failed read and composes concurrent flushes', async () => {
        const {repository, reads, db} = await fixture();
        await db.logs.put(log('first'));
        repository.sync.recordCacheChanges({entities:[{entityType:'logs',entityId:'first'}], conflicts:[]});
        vi.spyOn(db.logs,'bulkGet').mockRejectedValueOnce(new Error('read failed'));
        await expect(reads.flush()).rejects.toThrow('read failed');
        await db.logs.put(log('second'));
        repository.sync.recordCacheChanges({entities:[{entityType:'logs',entityId:'second'}],conflicts:[]});
        await Promise.all([reads.flush(), reads.flush()]);
        expect(reads.getLogs().map(x=>x.id).sort()).toEqual(['first','second']);
    });
    it('retries a failed full reconciliation before accepting a later bounded delta', async () => {
        const {repository, reads, db} = await fixture();
        await db.logs.put(log('missed'));
        vi.spyOn(repository.sync, 'readAll').mockRejectedValueOnce(new Error('read failed'));
        await expect(reads.reload()).rejects.toThrow('read failed');
        await db.logs.put(log('next'));
        repository.sync.cacheChanges.add({entities:[{entityType:'logs',entityId:'next'}],conflicts:[]});
        await reads.flush();
        expect(reads.getLogs().map(row=>row.id).sort()).toEqual(['missed','next']);
    });
    it('does not publish failed transaction IDs and never populates a different account cache', async () => {
        const {repository, reads, db, notify} = await fixture();
        await expect(repository.mutate([db.logs], async () => {
            await db.logs.put(log('rollback')); throw new Error('abort');
        })).rejects.toThrow('abort');
        expect(repository.sync.cacheChanges.take().entities).toEqual([]);
        expect(repository.sync.outgoingChanges.take().entities).toEqual([]);
        expect(await db.logs.get('rollback')).toBeUndefined();
        const refresh = reads.flush();
        await activateAccountDatabase(`other-${crypto.randomUUID()}`);
        await refresh.catch(() => undefined);
        expect(notify).not.toHaveBeenCalled();
    });
    it('broadcasts own committed IDs even when an incoming refresh already drained them', async () => {
        const posted = vi.fn();
        vi.stubGlobal('BroadcastChannel', class { addEventListener() {} close() {} postMessage(data: unknown) { posted(data); } });
        const {repository, reads, db} = await fixture();
        const coordinator = new SyncCoordinator(repository, reads, () => {}, 1000, true);
        try {
            await db.logs.put(log('own'));
            repository.sync.recordCacheChanges({entities:[{entityType:'logs',entityId:'own'}],conflicts:[]});
            await db.logs.put(log('incoming'));
            repository.sync.cacheChanges.add({entities:[{entityType:'logs',entityId:'incoming'}],conflicts:[]});
            await reads.flush(); // Incoming refresh consumes both before the mutation continuation.
            coordinator.broadcastUpdate(await reads.flush());
            expect(posted.mock.calls[0][0].changes.entities).toEqual([{entityType:'logs',entityId:'own'}]);
        } finally { coordinator.dispose(); }
    });
    it('reads only changed conflict keys on restore and dismiss', async () => {
        const {reads, mutations, db} = await fixture();
        await db.syncConflicts.put({key:'logs:C', entityType:'logs',entityId:'C',createdAt:stamp,serverVersion:4,reason:'stale-version',localPayload:log('C'),serverPayload:log('C')});
        await reads.reload();
        const all = vi.spyOn(db.syncConflicts,'toArray');
        await mutations.restoreConflictLocal('logs:C');
        expect(reads.getLogById('C')?.version).toBe(4); expect(reads.getConflicts()).toEqual([]);
        await mutations.dismissConflict('missing'); expect(all).not.toHaveBeenCalled();
    });
});

it('latest index matches event-time selection through edits, deletes, ties and invalid dates', () => {
    const index = new LatestLogIndex(); const records = new Map<string, WorkoutSet>();
    for (let i = 0; i < 500; i++) {
        const row = log(String(i), new Date(Date.parse(stamp) + ((i * 7919) % 101) * 60000).toISOString());
        records.set(row.id,row); index.put(row.id,row);
        expect(index.get()?.id).toBe(getLatestLog([...records.values()])?.id);
    }
    for (let i = 0; i < 500; i++) {
        const id = String((i * 137) % 500);
        const row = {...records.get(id)!, date: i % 3 ? 'invalid' : '2026-01-01T00:00:00Z', isDeleted: i % 7 === 0};
        records.set(id,row); index.put(id,row);
        expect(index.get()?.id).toBe(getLatestLog([...records.values()])?.id);
    }
});
