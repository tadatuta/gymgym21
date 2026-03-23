import Dexie, { Table } from 'dexie';
import { WorkoutSession, WorkoutSet, WorkoutType, UserProfile } from './types';

export class GymDatabase extends Dexie {
    workouts!: Table<WorkoutSession>;
    logs!: Table<WorkoutSet>;
    workoutTypes!: Table<WorkoutType>;
    profile!: Table<UserProfile>;

    constructor() {
        super('GymDatabase');
        this.version(1).stores({
            workouts: 'id, status, startTime, updatedAt, isDeleted',
            logs: 'id, workoutId, workoutTypeId, date, updatedAt, isDeleted',
            workoutTypes: 'id, updatedAt, isDeleted',
            profile: 'id, updatedAt, isDeleted' // Profile usually has one entry, we can use a constant ID 'me'
        });
    }
}

export const db = new GymDatabase();
