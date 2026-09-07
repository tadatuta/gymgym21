import type { AppData, SyncConflictRecord, WorkoutSession, WorkoutSet, WorkoutType, UserProfile } from '../types';
import { accountTimeZone } from '../utils/training-time';
import { sessionDurationSeconds } from '../utils/duration';
import { domainSnapshot } from './domain-snapshot';
import type { AccountRepository } from './account-repository';
export class AccountReads {
    data: AppData = { workoutTypes: [], logs: [], workouts: [] };
    private conflicts: SyncConflictRecord[] = [];
    pendingCount = 0;
    private loaded = false;
    constructor(private readonly repository: AccountRepository,
        private readonly notify: (changed: boolean, pendingChanged: boolean) => void) {}

    async reload() {
        const { context, database, sync } = this.repository;
        context.assertCurrent();
        const snapshot = await Promise.all([
            sync.readAll(), database.syncConflicts.orderBy('createdAt').reverse().toArray(), database.dirtyEntities.count(),
        ]).catch(error => {
            if (context.isCurrent()) throw error;
            return undefined;
        });
        if (!snapshot || !context.isCurrent()) return;
        const [data, conflicts, pendingCount] = snapshot;
        const changed = !this.loaded || domainSnapshot(this.data) !== domainSnapshot(data)
            || JSON.stringify(this.conflicts) !== JSON.stringify(conflicts);
        const pendingChanged = this.pendingCount !== pendingCount;
        this.loaded = true;
        this.data = data;
        this.conflicts = conflicts;
        this.pendingCount = pendingCount;
        this.notify(changed, pendingChanged);
    }

    getWorkoutTypes(): WorkoutType[] {
        return this.data.workoutTypes
            .filter((item) => !item.isDeleted)
            .sort((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity));
    }

    getLogs(): WorkoutSet[] {
        return this.data.logs.filter((item) => !item.isDeleted);
    }

    getWorkouts(): WorkoutSession[] {
        return this.data.workouts.filter((item) => !item.isDeleted);
    }

    getActiveWorkout(): WorkoutSession | undefined {
        return this.data.workouts.find(
            (workout) => !workout.isDeleted && (workout.status === 'active' || workout.status === 'paused'),
        );
    }

    getProfile(): UserProfile | undefined {
        return this.data.profile;
    }

    getTimeZone(): string {
        return accountTimeZone(this.data.profile?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    }

    getConflicts(): SyncConflictRecord[] {
        return [...this.conflicts];
    }

    getWorkoutDuration(workout: WorkoutSession): number {
        return sessionDurationSeconds(workout, this.data.logs) / 60;
    }

    getProfileIdentifier(): string {
        const profile = this.data.profile;
        if (profile?.username) return profile.username;
        if (profile?.telegramUsername) return profile.telegramUsername;
        return profile?.telegramUserId ? `id_${profile.telegramUserId}` : '';
    }

    isFriend(identifier: string): boolean {
        return this.data.profile?.friends?.some((friend) => friend.identifier === identifier) ?? false;
    }
}
