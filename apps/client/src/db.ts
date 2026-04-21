import Dexie, { Table } from 'dexie';
import {
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

    constructor() {
        super('GymDatabase');
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
    }
}

export const db = new GymDatabase();
