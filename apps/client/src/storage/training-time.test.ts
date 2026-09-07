import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import source from '../main.ts?raw';
import { db } from '../db';
import { StorageService } from './storage';
import { parseDatetimeValue } from '../utils/training-time';
import { SyncService } from '../services/sync';
vi.mock('../auth', () => ({ authorizedApiFetch: vi.fn(), clearAuthState: vi.fn(), getCurrentUser: () => null, hasActiveSession: () => true, hasVerifiedOnlineAccount: () => false, resolveApiUrl: (s: string) => s }));
let service: StorageService;
const stamp = '2026-01-01T21:30:00Z';
beforeEach(async () => {
    service = new StorageService({ enableBroadcast: false });
    await service.activate(`time-${Math.random()}`);
    await db.profile.put({ id: 'me', timeZone: 'Europe/Moscow', isPublic: false, createdAt: stamp, updatedAt: stamp });
    await service.reloadCache();
});
afterEach(() => { service.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
const workout = (id: string, date = stamp, isManual = false) => ({ id, startTime: date, endTime: date, status: 'finished' as const, isManual, pauseIntervals: [], updatedAt: stamp });
const log = (id: string, workoutId: string, date = stamp) => ({ id, workoutId, workoutTypeId: 'time', date, durationSeconds: 30, updatedAt: stamp });
async function seed() {
    await db.workouts.bulkPut([workout('old'), workout('new', '2026-01-02T23:00:00Z'), workout('manual', stamp, true)]);
    await db.logs.bulkPut([log('a', 'old'), log('b', 'old', '2026-01-01T22:30:00Z'), log('c', 'new', '2026-01-02T23:00:00Z'), log('d', 'manual')]);
    await service.reloadCache();
}
describe('transactional training dates and actual form measurement updates', () => {
    it('persists browser fallback once after bootstrap and preserves a newer explicit choice', async () => {
        await db.profile.update('me', { timeZone: undefined });
        await service.reloadCache();
        const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        expect(service.getTimeZone()).toBe(browserZone);
        await service['ensureProfileTimeZoneAfterBootstrap']();
        expect((await db.profile.get('me'))?.timeZone).toBe(browserZone);
        expect((await db.dirtyEntities.toArray()).map(x => x.key)).toEqual(['profile:me']);
        await db.profile.update('me', { timeZone: undefined }); await service.reloadCache();
        await db.profile.update('me', { timeZone: 'Pacific/Auckland' });
        await service['ensureProfileTimeZoneAfterBootstrap']();
        expect((await db.profile.get('me'))?.timeZone).toBe('Pacific/Auckland');
    });

    it('groups new implicit logs by account day even across UTC midnight', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
        const first = await service.addLog({ workoutTypeId: 'time', durationSeconds: 30 });
        vi.setSystemTime(new Date('2026-01-02T01:30:00Z'));
        const second = await service.addLog({ workoutTypeId: 'time' });
        expect(second.workoutId).toBe(first.workoutId);
        expect(service.getWorkoutDuration(service.getWorkouts()[0])).toBe(240);
    });
    it('moves implicit bounds and tombstones the last empty source; manual bounds stay unchanged', async () => {
        await seed();
        await service.updateLog({ ...service.getLogs().find(l => l.id === 'a')!, date: '2026-01-02T21:30:00Z' });
        expect((await db.logs.get('a'))?.workoutId).toBe('new');
        expect((await db.workouts.get('old'))?.startTime).toBe('2026-01-01T22:30:00Z');
        expect((await db.workouts.get('new'))?.startTime).toBe('2026-01-02T21:30:00Z');
        await service.updateLog({ ...service.getLogs().find(l => l.id === 'b')!, date: '2026-01-02T22:00:00Z' });
        expect((await db.workouts.get('old'))?.isDeleted).toBe(true);
        const manual = await db.workouts.get('manual');
        await service.updateLog({ ...service.getLogs().find(l => l.id === 'd')!, date: '2026-02-01T12:00:00Z' });
        expect(await db.workouts.get('manual')).toEqual(manual);
        expect((await db.dirtyEntities.toArray()).map(x => x.key).sort()).toEqual(['logs:a', 'logs:b', 'logs:d', 'workouts:new', 'workouts:old']);
    });
    it('rolls back logs and both session bounds when the outbox write fails', async () => {
        await seed();
        const before = { logs: await db.logs.toArray(), workouts: await db.workouts.toArray() };
        vi.spyOn(SyncService, 'markDirtyMany').mockRejectedValue(new Error('outbox failure'));
        await expect(service.updateLog({ ...service.getLogs()[0], date: '2026-03-01T12:00:00Z' })).rejects.toThrow('outbox failure');
        expect(await db.logs.toArray()).toEqual(before.logs);
        expect(await db.workouts.toArray()).toEqual(before.workouts);
        expect(await db.dirtyEntities.count()).toBe(0);
    });
    it('actual DOM submit clears 30 seconds to zero, clears category fields, and moves dates in fake IndexedDB', async () => {
        await seed();
        await db.workoutTypes.bulkPut([{ id: 'time', name: 'Time', category: 'time', updatedAt: stamp }, { id: 'strength', name: 'Strength', category: 'strength', updatedAt: stamp }]);
        await service.reloadCache();
        const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
        let callback: ts.Node | undefined;
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && node.expression.getText(ast) === 'form?.addEventListener' && node.arguments[0]?.getText(ast) === "'submit'") callback = node.arguments[1];
            ts.forEachChild(node, visit);
        }; visit(ast);
        expect(callback).toBeDefined();
        const compiled = ts.transpileModule(`const handler = ${callback!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
        document.body.innerHTML = '<form><input name="typeId" value="time"><input name="duration_seconds" value="0"><input name="date" value="2026-01-03T00:30"><input name="weight" value="20"><input name="reps" value="5"></form>';
        const form = document.querySelector('form')!;
        let pending: Promise<void>;
        const context = { form, storage: service, formDrafts: null, editingLogId: 'a', parseDatetimeValue, showToast: vi.fn(), render: () => {} };
        const handler = new Function(...Object.keys(context), `${compiled}; return handler;`)(...Object.values(context));
        form.addEventListener('submit', e => { pending = handler(e); });
        const submit = async () => { form.dispatchEvent(new Event('submit', { cancelable: true })); await pending; };
        await submit();
        expect(await db.logs.get('a')).toMatchObject({ duration: 0, durationSeconds: undefined, workoutId: 'new', date: '2026-01-02T21:30:00.000Z' });
        (form.elements.namedItem('typeId') as HTMLInputElement).value = 'strength';
        await submit();
        expect(await db.logs.get('a')).toMatchObject({ weight: 20, reps: 5, duration: undefined, durationSeconds: undefined });
        (form.elements.namedItem('typeId') as HTMLInputElement).value = 'time';
        await submit();
        expect(await db.logs.get('a')).toMatchObject({ weight: undefined, reps: undefined, duration: 0 });
        expect((await db.dirtyEntities.toArray()).map(x => x.key).sort()).toEqual(['logs:a', 'workouts:new', 'workouts:old']);
    });
});
