import Dexie, { Table } from 'dexie';
import {
    CachedAiResultRecord,
    CachedPublicProfileRecord,
    DirtyEntityRecord,
    SyncConflictRecord,
    SyncStateRecord,
    WorkoutSession,
    WorkoutSet,
    WorkoutType,
    UserProfile,
} from './types';

export class GymDatabase extends Dexie {
    workouts!: Table<WorkoutSession>;
    logs!: Table<WorkoutSet>;
    workoutTypes!: Table<WorkoutType>;
    profile!: Table<UserProfile>;
    dirtyEntities!: Table<DirtyEntityRecord>;
    syncState!: Table<SyncStateRecord>;
    syncConflicts!: Table<SyncConflictRecord>;
    publicProfileCache!: Table<CachedPublicProfileRecord>;
    aiResultCache!: Table<CachedAiResultRecord>;

    constructor(databaseName = LEGACY_DATABASE_NAME) {
        super(databaseName);
        this.version(1).stores({
            workouts: 'id, status, startTime, updatedAt, isDeleted',
            logs: 'id, workoutId, workoutTypeId, date, updatedAt, isDeleted',
            workoutTypes: 'id, updatedAt, isDeleted',
            profile: 'id, updatedAt, isDeleted' // Profile usually has one entry, we can use a constant ID 'me'
        });
        this.version(2).stores({
            workouts: 'id, status, startTime, updatedAt, version, serverUpdatedAt, isDeleted',
            logs: 'id, workoutId, workoutTypeId, date, updatedAt, version, serverUpdatedAt, isDeleted',
            workoutTypes: 'id, updatedAt, version, serverUpdatedAt, isDeleted',
            profile: 'id, updatedAt, version, serverUpdatedAt, isDeleted',
            dirtyEntities: '&key, entityType, queuedAt',
            syncState: '&key'
        });
        this.version(3).stores({
            workouts: 'id, status, startTime, updatedAt, version, serverUpdatedAt, isDeleted',
            logs: 'id, workoutId, workoutTypeId, date, updatedAt, version, serverUpdatedAt, isDeleted',
            workoutTypes: 'id, updatedAt, version, serverUpdatedAt, isDeleted',
            profile: 'id, updatedAt, version, serverUpdatedAt, isDeleted',
            dirtyEntities: '&key, entityType, queuedAt',
            syncState: '&key',
            syncConflicts: '&key, entityType, createdAt'
        });
        this.version(4).stores({
            workouts: 'id, status, startTime, updatedAt, version, serverUpdatedAt, isDeleted',
            logs: 'id, workoutId, workoutTypeId, date, updatedAt, version, serverUpdatedAt, isDeleted',
            workoutTypes: 'id, updatedAt, version, serverUpdatedAt, isDeleted',
            profile: 'id, updatedAt, version, serverUpdatedAt, isDeleted',
            dirtyEntities: '&key, entityType, queuedAt, generation',
            syncState: '&key',
            syncConflicts: '&key, entityType, createdAt',
            publicProfileCache: '&identifier, cachedAt',
            aiResultCache: '&type, updatedAt'
        });
    }
}

export const LEGACY_DATABASE_NAME = 'GymDatabase';
const ACCOUNT_DATABASE_PREFIX = 'GymDatabase:account:';
const LEGACY_MIGRATION_KEY = 'gym21_legacy_idb_owner_v1';
const INACTIVE_DATABASE_NAME = 'GymDatabase:inactive';

export let db = new GymDatabase(INACTIVE_DATABASE_NAME);

let activeStorageKey: string | null = null;

function accountDatabaseName(storageKey: string): string {
    return `${ACCOUNT_DATABASE_PREFIX}${encodeURIComponent(storageKey)}`;
}

function hasBrowserStorage(): boolean {
    return typeof localStorage !== 'undefined';
}

async function databaseHasDomainData(database: GymDatabase): Promise<boolean> {
    const [workoutTypes, workouts, logs, profiles] = await Promise.all([
        database.workoutTypes.count(),
        database.workouts.count(),
        database.logs.count(),
        database.profile.count(),
    ]);
    return workoutTypes + workouts + logs + profiles > 0;
}

async function copyLegacyDatabase(target: GymDatabase, storageKey: string): Promise<void> {
    if (!await Dexie.exists(LEGACY_DATABASE_NAME)) {
        return;
    }

    if (hasBrowserStorage()) {
        const recordedOwner = localStorage.getItem(LEGACY_MIGRATION_KEY);
        if (recordedOwner && recordedOwner !== storageKey) {
            return;
        }
    }

    const legacy = new GymDatabase(LEGACY_DATABASE_NAME);
    await legacy.open();

    try {
        if (!await databaseHasDomainData(legacy)) {
            return;
        }

        if (await databaseHasDomainData(target)) {
            if (hasBrowserStorage()) {
                localStorage.setItem(LEGACY_MIGRATION_KEY, storageKey);
            }
            return;
        }

        const [workouts, logs, workoutTypes, profiles, dirtyEntities, syncState, syncConflicts] = await Promise.all([
            legacy.workouts.toArray(),
            legacy.logs.toArray(),
            legacy.workoutTypes.toArray(),
            legacy.profile.toArray(),
            legacy.dirtyEntities.toArray(),
            legacy.syncState.toArray(),
            legacy.syncConflicts.toArray(),
        ]);

        await target.transaction(
            'rw',
            [
                target.workouts,
                target.logs,
                target.workoutTypes,
                target.profile,
                target.dirtyEntities,
                target.syncState,
                target.syncConflicts,
            ],
            async () => {
                if (workouts.length > 0) await target.workouts.bulkPut(workouts);
                if (logs.length > 0) await target.logs.bulkPut(logs);
                if (workoutTypes.length > 0) await target.workoutTypes.bulkPut(workoutTypes);
                if (profiles.length > 0) await target.profile.bulkPut(profiles);
                if (dirtyEntities.length > 0) await target.dirtyEntities.bulkPut(dirtyEntities);
                if (syncState.length > 0) await target.syncState.bulkPut(syncState);
                if (syncConflicts.length > 0) await target.syncConflicts.bulkPut(syncConflicts);
            },
        );

        if (hasBrowserStorage()) {
            localStorage.setItem(LEGACY_MIGRATION_KEY, storageKey);
        }
    } finally {
        legacy.close();
    }
}

export async function activateAccountDatabase(storageKey: string): Promise<GymDatabase> {
    const normalizedStorageKey = storageKey.trim();
    if (!normalizedStorageKey) {
        throw new Error('Cannot activate a local database without a storage key');
    }

    if (activeStorageKey === normalizedStorageKey) {
        return db;
    }

    const nextDatabase = new GymDatabase(accountDatabaseName(normalizedStorageKey));
    await nextDatabase.open();
    await copyLegacyDatabase(nextDatabase, normalizedStorageKey);

    db.close();
    db = nextDatabase;
    activeStorageKey = normalizedStorageKey;
    return db;
}

export function getActiveStorageKey(): string | null {
    return activeStorageKey;
}

export function isAccountDatabaseActive(): boolean {
    return activeStorageKey !== null;
}

export function closeActiveDatabase() {
    db.close();
    db = new GymDatabase(INACTIVE_DATABASE_NAME);
    activeStorageKey = null;
}
