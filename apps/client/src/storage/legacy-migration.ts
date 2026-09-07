import type { AppData } from '../types';
import { createEntityId } from '../utils/entity-id';
import type { AccountRepository } from './account-repository';
import { createDefaultWorkoutTypes } from './bootstrap';
import type { CachedAiResults } from './remote-reads';
const LEGACY_LOCAL_STORAGE_KEY = 'gym_twa_data';
const LEGACY_LOCAL_STORAGE_OWNER_KEY = 'gym21_legacy_local_storage_owner_v1';
const LEGACY_AI_RESULTS_KEY = 'gym_ai_results';
const LEGACY_AI_OWNER_KEY = 'gym21_legacy_ai_owner_v1';
const PROFILE_ID = 'me';

export async function migrateFromLocalStorage(repository: AccountRepository, storageKey: string) {
    const { database: db, context, sync } = repository;
    context.assertCurrent();
    const json = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
    if (!json) {
        return;
    }

    context.assertCurrent();
    const recordedOwner = localStorage.getItem(LEGACY_LOCAL_STORAGE_OWNER_KEY);
    if (recordedOwner && recordedOwner !== storageKey) {
        return;
    }

    try {
        const hasLocalData = (
            await db.workoutTypes.count()
            + await db.logs.count()
            + await db.workouts.count()
            + await db.profile.count()
        ) > 0;
        if (hasLocalData) {
            context.assertCurrent();
            localStorage.setItem(LEGACY_LOCAL_STORAGE_OWNER_KEY, storageKey);
            return;
        }

        const oldData = JSON.parse(json) as Partial<AppData>;
        const now = new Date().toISOString();
        const workoutTypes = (oldData.workoutTypes || createDefaultWorkoutTypes()).map((item) => ({
            ...item,
            id: item.id || createEntityId(),
            updatedAt: now,
        }));
        const logs = (oldData.logs || []).map((item) => ({
            ...item,
            id: item.id || createEntityId(),
            updatedAt: now,
            workoutId: item.workoutId || 'legacy',
        }));
        const workouts = (oldData.workouts || []).map((item) => ({
            ...item,
            id: item.id || createEntityId(),
            updatedAt: now,
        }));
        const profile = oldData.profile
            ? { ...oldData.profile, id: PROFILE_ID, updatedAt: now }
            : undefined;

        await repository.transaction(
            [db.workoutTypes, db.logs, db.workouts, db.profile, db.dirtyEntities],
            async () => {
                if (workoutTypes.length > 0) await db.workoutTypes.bulkPut(workoutTypes);
                if (logs.length > 0) await db.logs.bulkPut(logs);
                if (workouts.length > 0) await db.workouts.bulkPut(workouts);
                if (profile) await db.profile.put(profile);
                await sync.markDirtyMany([
                    ...workoutTypes.map((item) => ({ entityType: 'workoutTypes' as const, entityId: item.id })),
                    ...logs.map((item) => ({ entityType: 'logs' as const, entityId: item.id })),
                    ...workouts.map((item) => ({ entityType: 'workouts' as const, entityId: item.id })),
                    ...(profile ? [{ entityType: 'profile' as const, entityId: PROFILE_ID }] : []),
                ]);
            },
        );
        context.assertCurrent();
        localStorage.setItem(LEGACY_LOCAL_STORAGE_OWNER_KEY, storageKey);
    } catch (error) {
        context.assertCurrent();
        console.error('Legacy localStorage migration failed', error);
    }
}

export async function migrateLegacyAiResults(repository: AccountRepository, storageKey: string) {
    const { database: db, context } = repository;
    context.assertCurrent();
    if (await db.aiResultCache.count() > 0) {
        return;
    }

    context.assertCurrent();
    const recordedOwner = localStorage.getItem(LEGACY_AI_OWNER_KEY);
    if (recordedOwner && recordedOwner !== storageKey) {
        return;
    }

    try {
        const parsed = JSON.parse(localStorage.getItem(LEGACY_AI_RESULTS_KEY) || 'null') as {
            version?: number;
            results?: Partial<CachedAiResults>;
        } | null;
        if (parsed?.version !== 2 || !parsed.results) {
            return;
        }

        const now = new Date().toISOString();
        const records = (['general', 'plan'] as const)
            .flatMap((type) => typeof parsed.results?.[type] === 'string'
                ? [{ type, markdown: parsed.results[type], updatedAt: now }]
                : []);
        if (records.length > 0) {
            await repository.transaction([db.aiResultCache], () => db.aiResultCache.bulkPut(records));
            context.assertCurrent();
            localStorage.setItem(LEGACY_AI_OWNER_KEY, storageKey);
        }
    } catch {
        context.assertCurrent();
        // Ignore malformed legacy AI cache values.
    }
}
