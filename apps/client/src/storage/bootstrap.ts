import type { WorkoutType } from '../types';
import type { AccountRepository } from './account-repository';
import type { AccountReads } from './account-reads';
const PROFILE_ID = 'me';
export function createDefaultWorkoutTypes(): WorkoutType[] {
    const now = new Date().toISOString();
    return [
        { id: 'default-bench-press', name: 'Жим лежа', order: 1, updatedAt: now },
        { id: 'default-squat', name: 'Приседания', order: 2, updatedAt: now },
        { id: 'default-deadlift', name: 'Становая тяга', order: 3, updatedAt: now },
    ];
}

export async function ensureProfileTimeZoneAfterBootstrap(repository: AccountRepository, reads: AccountReads): Promise<boolean> {
    // Run only after the complete pull. Recheck inside the transaction so another tab's choice wins.
    const cachedProfile = reads.getProfile();
    if (!cachedProfile || cachedProfile.timeZone) return false;
    const context = repository.context;
    const database = context.database;
    const sync = repository.sync;
    const timeZone = reads.getTimeZone();
    let changed = false;
    await repository.transaction([database.profile, database.dirtyEntities], async () => {
        context.assertCurrent();
        const profile = await database.profile.get(PROFILE_ID);
        context.assertCurrent();
        if (!profile || profile.timeZone || profile.isDeleted) return;
        await database.profile.put({ ...profile, timeZone, updatedAt: new Date().toISOString() });
        context.assertCurrent();
        await sync.markDirtyMany([{ entityType: 'profile', entityId: PROFILE_ID }]);
        context.assertCurrent();
        changed = true;
    });
    context.assertCurrent();
    if (changed) { repository.sync.recordCacheChanges({ entities: [{entityType: 'profile', entityId: PROFILE_ID}], conflicts: [] }); await reads.flush(); context.assertCurrent(); }
    return changed;
}

export async function ensureDefaultWorkoutTypesAfterBootstrap(repository: AccountRepository, reads: AccountReads): Promise<boolean> {
    const { database: db, context } = repository;
    context.assertCurrent();
    if (await db.workoutTypes.count() > 0) {
        return false;
    }

    const defaults = createDefaultWorkoutTypes();
    await repository.transaction([db.workoutTypes, db.dirtyEntities], async () => {
        if (await db.workoutTypes.count() > 0) return;
        await db.workoutTypes.bulkPut(defaults);
        await repository.sync.markDirtyMany(
            defaults.map((item) => ({ entityType: 'workoutTypes', entityId: item.id })),
        );
    });
    context.assertCurrent();
    repository.sync.recordCacheChanges({entities: defaults.map(item => ({entityType: 'workoutTypes', entityId: item.id})), conflicts: []});
    await reads.flush();
    context.assertCurrent();
    return true;
}
