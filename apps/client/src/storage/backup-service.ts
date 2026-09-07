import type { Table } from 'dexie';
import type { WorkoutSession, WorkoutSet, WorkoutType, UserProfile } from '../types';
import { readBackup, type BackupMode } from './backup';
import type { AccountRepository } from './account-repository';
import type { AccountReads } from './account-reads';
import type { SyncCoordinator } from './sync-coordinator';
export async function importAccountBackup(repository: AccountRepository, reads: AccountReads, coordinator: SyncCoordinator, input: unknown, mode: BackupMode): Promise<void> {
    repository.context.assertCurrent();
    const context = repository.context;
    const database = context.database;
    const data = readBackup(input);
    if (Date.now() < coordinator.retryAt) throw new Error('Сервер попросил подождать. Повторите импорт после автоматической синхронизации');
    coordinator.clearScheduledSync();
    if (coordinator.syncInFlight) throw new Error('Дождитесь завершения синхронизации и повторите импорт');
    if (mode !== 'merge' && mode !== 'replace') throw new Error('Выберите режим импорта');
    if (navigator.onLine) {
        coordinator.syncInFlight = true;
        try {
            const acquired = await coordinator.withSyncLock(() => repository.sync.importBackup(data, mode));
            if (!acquired) throw new Error('Синхронизация выполняется в другой вкладке. Повторите импорт');
        } finally {
            if (context.isCurrent()) {
                coordinator.syncInFlight = false;
                // Preflight may have pulled changes even if the import itself failed.
                await reads.reload();
                context.assertCurrent();
                coordinator.broadcastUpdate();
                if (coordinator.syncQueued) {
                    coordinator.syncQueued = false;
                    coordinator.scheduleSync(0);
                }
            }
        }
    } else {
        if (mode === 'replace') throw new Error('Замена данных требует подключения к серверу. Объединение доступно офлайн');
        const sync = repository.sync;
        await repository.transaction([database.workouts, database.logs, database.workoutTypes, database.profile, database.dirtyEntities], async () => {
            for (const entityType of ['workouts', 'logs', 'workoutTypes', 'profile'] as const) {
                const table = database[entityType] as Table<WorkoutSession | WorkoutSet | WorkoutType | UserProfile, string>;
                const entries = entityType === 'profile' ? (data.profile ? [data.profile] : []) : data[entityType];
                for (const entry of entries) {
                    const current = await table.get(entry.id);
                    await table.put({ ...entry, version: current?.version, serverUpdatedAt: current?.serverUpdatedAt });
                    await sync.markDirty(entityType, entry.id);
                }
            }
            context.assertCurrent();
        });
    }
    context.assertCurrent();
    await repository.transaction([database.aiResultCache], () => database.aiResultCache.clear());
    context.assertCurrent();
    await reads.reload();
    context.assertCurrent();
    coordinator.broadcastUpdate();
    coordinator.scheduleSync(0);
}
