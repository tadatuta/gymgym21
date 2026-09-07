import type { Table } from 'dexie';
import type { SyncItem, UserProfile, WorkoutSession, WorkoutSet, WorkoutType } from '../types';
import { dayKey } from '../utils/training-time';
import { createEntityId } from '../utils/entity-id';
import { getCurrentUser } from '../auth';
import { AccountRepository, type MutationResult } from './account-repository';
import type { AccountReads } from './account-reads';
const PROFILE_ID = 'me';
function cloneWorkout(workout: WorkoutSession): WorkoutSession {
    return {
        ...workout,
        pauseIntervals: workout.pauseIntervals.map((interval) => ({ ...interval })),
    };
}

export class DomainMutations {
    constructor(private readonly repository: AccountRepository, private readonly reads: AccountReads,
        private readonly changed: () => Promise<void>) {}

    private async commitMutation<T>(tables: Table[], mutation: () => Promise<MutationResult<T>>): Promise<T> {
        const result = await this.repository.mutate(tables, mutation);
        this.repository.context.assertCurrent();
        await this.changed();
        this.repository.context.assertCurrent();
        return result;
    }

    async addWorkoutType(name: string, category: 'strength' | 'time' = 'strength'): Promise<WorkoutType> {
        const types = this.reads.getWorkoutTypes();
        const maxOrder = types.length > 0 ? Math.max(...types.map((item) => item.order ?? 0)) : 0;
        const newType: WorkoutType = {
            id: createEntityId(),
            name,
            category,
            order: maxOrder + 1,
            updatedAt: new Date().toISOString(),
        };

        return this.commitMutation([this.repository.database.workoutTypes], async () => {
            await this.repository.database.workoutTypes.put(newType);
            return {
                value: newType,
                dirty: [{ entityType: 'workoutTypes', entityId: newType.id }],
            };
        });
    }

    async deleteWorkoutType(id: string): Promise<void> {
        await this.commitMutation([this.repository.database.workoutTypes], async () => {
            const existing = await this.repository.database.workoutTypes.get(id);
            if (!existing) return { value: undefined, dirty: [] };
            await this.repository.database.workoutTypes.put({
                ...existing,
                isDeleted: true,
                updatedAt: new Date().toISOString(),
            });
            return {
                value: undefined,
                dirty: [{ entityType: 'workoutTypes', entityId: id }],
            };
        });
    }

    async updateWorkoutType(id: string, name: string, category?: 'strength' | 'time'): Promise<void> {
        await this.commitMutation([this.repository.database.workoutTypes], async () => {
            const existing = await this.repository.database.workoutTypes.get(id);
            if (!existing) return { value: undefined, dirty: [] };
            await this.repository.database.workoutTypes.put({
                ...existing,
                name,
                ...(category ? { category } : {}),
                updatedAt: new Date().toISOString(),
            });
            return {
                value: undefined,
                dirty: [{ entityType: 'workoutTypes', entityId: id }],
            };
        });
    }

    async startWorkout(name?: string): Promise<WorkoutSession> {
        const now = new Date().toISOString();
        const newWorkout: WorkoutSession = {
            id: createEntityId(),
            startTime: now,
            status: 'active',
            name,
            isManual: true,
            pauseIntervals: [],
            updatedAt: now,
        };

        return this.commitMutation([this.repository.database.workouts], async () => {
            const activeWorkouts = await this.repository.database.workouts.where('status').anyOf('active', 'paused').toArray();
            const dirty = activeWorkouts.map((workout) => ({
                entityType: 'workouts' as const,
                entityId: workout.id,
            }));
            for (const workout of activeWorkouts) {
                const finished = cloneWorkout(workout);
                finished.status = 'finished';
                finished.endTime = now;
                const lastPause = finished.pauseIntervals.at(-1);
                if (lastPause && !lastPause.end) lastPause.end = now;
                finished.updatedAt = now;
                await this.repository.database.workouts.put(finished);
            }

            await this.repository.database.workouts.put(newWorkout);
            dirty.push({ entityType: 'workouts', entityId: newWorkout.id });
            return { value: newWorkout, dirty };
        });
    }

    async pauseWorkout(): Promise<void> {
        await this.changeActiveWorkout((workout, now) => {
            if (workout.status !== 'active') return null;
            workout.status = 'paused';
            workout.pauseIntervals.push({ start: now });
            return workout;
        });
    }

    async resumeWorkout(): Promise<void> {
        await this.changeActiveWorkout((workout) => {
            if (workout.status !== 'paused') return null;
            workout.status = 'active';
            const lastPause = workout.pauseIntervals.at(-1);
            if (lastPause && !lastPause.end) lastPause.end = new Date().toISOString();
            return workout;
        });
    }

    async finishWorkout(): Promise<void> {
        await this.changeActiveWorkout((workout, now) => {
            workout.status = 'finished';
            workout.endTime = now;
            const lastPause = workout.pauseIntervals.at(-1);
            if (lastPause && !lastPause.end) lastPause.end = now;
            return workout;
        });
    }

    private async changeActiveWorkout(
        change: (workout: WorkoutSession, now: string) => WorkoutSession | null,
    ): Promise<void> {
        await this.commitMutation([this.repository.database.workouts], async () => {
            const active = (await this.repository.database.workouts.where('status').anyOf('active', 'paused').first());
            if (!active) return { value: undefined, dirty: [] };
            const now = new Date().toISOString();
            const changed = change(cloneWorkout(active), now);
            if (!changed) return { value: undefined, dirty: [] };
            changed.updatedAt = now;
            await this.repository.database.workouts.put(changed);
            return {
                value: undefined,
                dirty: [{ entityType: 'workouts', entityId: changed.id }],
            };
        });
    }

    async updateWorkout(id: string, updates: { name?: string; startTime?: string; endTime?: string }): Promise<void> {
        await this.commitMutation([this.repository.database.workouts], async () => {
            const workout = await this.repository.database.workouts.get(id);
            if (!workout) return { value: undefined, dirty: [] };
            const next = cloneWorkout(workout);
            if (updates.name !== undefined) next.name = updates.name || undefined;
            if (updates.startTime) next.startTime = updates.startTime;
            if (updates.endTime) next.endTime = updates.endTime;
            next.updatedAt = new Date().toISOString();
            await this.repository.database.workouts.put(next);
            return {
                value: undefined,
                dirty: [{ entityType: 'workouts', entityId: id }],
            };
        });
    }

    private async ensureActiveWorkoutInTransaction(now: string, useActive = true): Promise<string> {
        const workouts = await this.repository.database.workouts.toArray();
        const active = workouts.find(w => !w.isDeleted && (w.status === 'active' || w.status === 'paused'));
        if (useActive && active) return active.id;
        const today = dayKey(now, this.reads.getTimeZone());
        const existing = workouts.filter(w => !w.isDeleted && !w.isManual && w.status === 'finished'
            && dayKey(w.startTime, this.reads.getTimeZone()) === today)
            .sort((a, b) => a.id.localeCompare(b.id))[0];
        if (existing) return existing.id;
        const id = createEntityId();
        await this.repository.database.workouts.put({ id, startTime: now, endTime: now, status: 'finished', isManual: false,
            pauseIntervals: [], updatedAt: new Date().toISOString() });
        return id;
    }

    private async updateImplicitWorkoutBoundsInTransaction(workoutId: string) {
        const workout = await this.repository.database.workouts.get(workoutId);
        if (!workout || workout.isManual) return;
        const activeLogs = (await this.repository.database.logs.where('workoutId').equals(workoutId).toArray())
            .filter((log) => !log.isDeleted)
            .sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
        if (activeLogs.length === 0) {
            await this.repository.database.workouts.put({ ...workout, isDeleted: true, updatedAt: new Date().toISOString() });
            return;
        }

        await this.repository.database.workouts.put({
            ...cloneWorkout(workout),
            startTime: activeLogs[0].date,
            endTime: activeLogs.at(-1)!.date,
            status: 'finished',
            updatedAt: new Date().toISOString(),
        });
    }

    async addLog(log: Omit<WorkoutSet, 'id' | 'date' | 'workoutId' | 'updatedAt' | 'isDeleted'>): Promise<WorkoutSet> {
        return this.commitMutation([this.repository.database.workouts, this.repository.database.logs], async () => {
            const now = new Date().toISOString();
            const workoutId = await this.ensureActiveWorkoutInTransaction(now);
            const newLog: WorkoutSet = {
                ...log,
                id: createEntityId(),
                date: now,
                workoutId,
                updatedAt: now,
            };
            await this.repository.database.logs.put(newLog);
            await this.updateImplicitWorkoutBoundsInTransaction(workoutId);
            return {
                value: newLog,
                dirty: [
                    { entityType: 'logs', entityId: newLog.id },
                    { entityType: 'workouts', entityId: workoutId },
                ],
            };
        });
    }

    async deleteLog(id: string): Promise<void> {
        await this.commitMutation([this.repository.database.workouts, this.repository.database.logs], async () => {
            const log = await this.repository.database.logs.get(id);
            if (!log) return { value: undefined, dirty: [] };
            const deleted = {
                ...log,
                isDeleted: true,
                updatedAt: new Date().toISOString(),
            };
            await this.repository.database.logs.put(deleted);
            if (log.workoutId) {
                await this.updateImplicitWorkoutBoundsInTransaction(log.workoutId);
            }
            return {
                value: undefined,
                dirty: [
                    { entityType: 'logs', entityId: log.id },
                    ...(log.workoutId
                        ? [{ entityType: 'workouts' as const, entityId: log.workoutId }]
                        : []),
                ],
            };
        });
    }

    async updateLog(updatedLog: WorkoutSet): Promise<void> {
        await this.commitMutation([this.repository.database.logs, this.repository.database.workouts], async () => {
            const existing = await this.repository.database.logs.get(updatedLog.id);
            if (!existing || existing.isDeleted) return { value: undefined, dirty: [] };
            const next = { ...updatedLog, updatedAt: new Date().toISOString() };
            const oldWorkout = existing.workoutId ? await this.repository.database.workouts.get(existing.workoutId) : undefined;
            const affected = new Set<string>();
            if (!oldWorkout?.isManual && existing.date !== next.date) {
                next.workoutId = await this.ensureActiveWorkoutInTransaction(next.date, false);
                if (oldWorkout) affected.add(oldWorkout.id);
                affected.add(next.workoutId);
            } else if (oldWorkout && !oldWorkout.isManual) affected.add(oldWorkout.id);
            await this.repository.database.logs.put(next);
            for (const id of affected) await this.updateImplicitWorkoutBoundsInTransaction(id);
            return { value: undefined, dirty: [
                { entityType: 'logs', entityId: next.id },
                ...[...affected].map(entityId => ({ entityType: 'workouts' as const, entityId })),
            ] };
        });
    }

    async updateProfileSettings(settings: Partial<UserProfile>): Promise<void> {
        await this.commitMutation([this.repository.database.profile], async () => {
            const authUser = getCurrentUser();
            const existing = await this.repository.database.profile.get(PROFILE_ID);
            const now = new Date().toISOString();
            const base: UserProfile = existing
                ? { ...existing, friends: [...(existing.friends ?? [])] }
                : {
                    id: PROFILE_ID,
                    isPublic: false,
                    timeZone: this.reads.getTimeZone(),
                    showFullHistory: false,
                    username: authUser?.username ?? undefined,
                    photoUrl: authUser?.image || undefined,
                    createdAt: now,
                    updatedAt: now,
                    friends: [],
                };
            const merged: UserProfile = {
                ...base,
                ...(authUser?.image ? { photoUrl: authUser.image } : {}),
                ...(authUser?.username ? { username: authUser.username } : {}),
                ...settings,
                id: PROFILE_ID,
                updatedAt: now,
            };
            merged.birthDate = merged.birthDate || undefined;
            await this.repository.database.profile.put(merged);
            return {
                value: undefined,
                dirty: [{ entityType: 'profile', entityId: PROFILE_ID }],
            };
        });
    }

    async addFriend(friend: { identifier: string; displayName: string; photoUrl?: string }): Promise<void> {
        const profile = this.reads.data.profile;
        if (!profile || profile.friends?.some((entry) => entry.identifier === friend.identifier)) return;
        await this.updateProfileSettings({
            friends: [
                ...(profile.friends || []),
                { ...friend, addedAt: new Date().toISOString() },
            ],
        });
    }

    async removeFriend(identifier: string): Promise<void> {
        const profile = this.reads.data.profile;
        if (!profile) return;
        await this.updateProfileSettings({
            friends: (profile.friends || []).filter((friend) => friend.identifier !== identifier),
        });
    }

    async updateWorkoutTypeOrder(ids: string[]): Promise<void> {
        await this.commitMutation([this.repository.database.workoutTypes], async () => {
            const now = new Date().toISOString();
            const updates: WorkoutType[] = [];
            ids.forEach((id, order) => {
                const type = this.reads.data.workoutTypes.find((entry) => entry.id === id);
                if (type) {
                    updates.push({ ...type, order, updatedAt: now });
                }
            });
            if (updates.length > 0) await this.repository.database.workoutTypes.bulkPut(updates);
            return {
                value: undefined,
                dirty: updates.map((entry) => ({ entityType: 'workoutTypes', entityId: entry.id })),
            };
        });
    }

    async restoreConflictLocal(key: string): Promise<void> {
        this.repository.context.assertCurrent();
        const conflict = await this.repository.database.syncConflicts.get(key);
        this.repository.context.assertCurrent();
        if (!conflict?.localPayload) return;
        const localPayload = conflict.localPayload as SyncItem & { id?: string };
        const rebased = {
            ...localPayload,
            id: conflict.entityType === 'profile' ? PROFILE_ID : (localPayload.id || conflict.entityId),
            version: conflict.serverVersion,
            serverUpdatedAt: conflict.serverPayload?.serverUpdatedAt,
            updatedAt: new Date().toISOString(),
        };
        const table = conflict.entityType === 'profile'
            ? this.repository.database.profile
            : conflict.entityType === 'workoutTypes'
                ? this.repository.database.workoutTypes
                : conflict.entityType === 'workouts'
                    ? this.repository.database.workouts
                    : this.repository.database.logs;

        await this.repository.transaction([table, this.repository.database.dirtyEntities, this.repository.database.syncConflicts], async () => {
            switch (conflict.entityType) {
                case 'profile':
                    await this.repository.database.profile.put(rebased as UserProfile);
                    break;
                case 'workoutTypes':
                    await this.repository.database.workoutTypes.put(rebased as WorkoutType);
                    break;
                case 'workouts':
                    await this.repository.database.workouts.put(rebased as WorkoutSession);
                    break;
                case 'logs':
                    await this.repository.database.logs.put(rebased as WorkoutSet);
                    break;
            }
            await this.repository.sync.markDirty(conflict.entityType, conflict.entityId);
            await this.repository.database.syncConflicts.delete(key);
        });
        await this.changed();
    }

    async dismissConflict(key: string): Promise<void> {
        await this.repository.transaction([this.repository.database.syncConflicts], () => this.repository.database.syncConflicts.delete(key));
        await this.changed();
    }
}
