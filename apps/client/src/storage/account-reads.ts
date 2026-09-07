import type { SyncConflictRecord, WorkoutSession, WorkoutSet, WorkoutType, UserProfile, SyncItem } from '../types';
import { accountTimeZone } from '../utils/training-time';
import { LatestLogIndex } from './latest-log-index';
import { sessionDurationSeconds } from '../utils/duration';
import { recordDomainSnapshot } from './domain-snapshot';
import type { AccountRepository } from './account-repository';
import type { CacheChanges } from './cache-changes';

/** Cached arrays are materialized only for consumers requesting the complete history. */
class EntityCache<T extends SyncItem & { id: string }> {
    readonly records = new Map<string, T>();
    private signatures = new Map<string, string | undefined>();
    private active?: T[];
    put(id: string, item: T | undefined): boolean {
        const signature = recordDomainSnapshot(item);
        const changed = this.signatures.get(id) !== signature;
        if (item) { this.records.set(id, item); this.signatures.set(id, signature); }
        else { this.records.delete(id); this.signatures.delete(id); }
        this.active = undefined;
        return changed;
    }
    get(id: string) { const item = this.records.get(id); return item?.isDeleted ? undefined : item; }
    values() { return this.active ??= [...this.records.values()].filter(item => !item.isDeleted); }
}
function lowerBound(values: string[], target: string) {
    let low = 0, high = values.length;
    while (low < high) { const mid = (low + high) >>> 1; if (values[mid] < target) low = mid + 1; else high = mid; }
    return low;
}
export class AccountReads {
    private readonly logs = new EntityCache<WorkoutSet>();
    private readonly workouts = new EntityCache<WorkoutSession>();
    private readonly activeWorkouts = new Map<string, WorkoutSession>();
    private readonly types = new EntityCache<WorkoutType>();
    private readonly conflicts = new Map<string, SyncConflictRecord>();
    private profile?: UserProfile;
    private readonly logsByDay = new Map<string, Map<string, WorkoutSet>>();
    private readonly logsByWorkout = new Map<string, Map<string, WorkoutSet>>();
    private readonly logDays = new Map<string, string>();
    private days: string[] = [];
    private readonly latest = new LatestLogIndex();
    private timeZone?: string;
    private dayFormatter?: Intl.DateTimeFormat;
    pendingCount = 0;
    private loaded = false;
    private reconcileRequired = false;
    private refreshTask: Promise<unknown> = Promise.resolve();
    constructor(private readonly repository: AccountRepository,
        private readonly notify: (changed: boolean, pendingChanged: boolean, changes?: CacheChanges) => void) {}

    /** Full reconciliation is reserved for activation, visibility and explicit bulk replacement. */
    async reload(): Promise<void> { await this.queue(true); }
    flush() { return this.queue(false); }
    private queue(full: boolean): Promise<CacheChanges | undefined> {
        const task = this.refreshTask.then(() => this.refresh(full));
        this.refreshTask = task.catch(() => undefined);
        return task;
    }
    private async refresh(full: boolean): Promise<CacheChanges | undefined> {
        const { context, database, sync } = this.repository;
        context.assertCurrent();
        const batch = sync.cacheChanges.take();
        full ||= !this.loaded || this.reconcileRequired;
        try {
            const snapshot = await database.transaction('r', [database.logs, database.workouts, database.workoutTypes,
                database.profile, database.syncConflicts, database.dirtyEntities], async () => {
                if (full) {
                    const [data, conflicts, pendingCount] = await Promise.all([
                        sync.readAll(), database.syncConflicts.toArray(), database.dirtyEntities.count(),
                    ]);
                    return { data, conflicts, pendingCount };
                }
                const ids = (type: string) => batch.entities.filter(item => item.entityType === type).map(item => item.entityId);
                const [logs, workouts, workoutTypes, profile, conflicts, pendingCount] = await Promise.all([
                    database.logs.bulkGet(ids('logs')), database.workouts.bulkGet(ids('workouts')),
                    database.workoutTypes.bulkGet(ids('workoutTypes')), ids('profile').length ? database.profile.get('me') : this.profile,
                    database.syncConflicts.bulkGet(batch.conflicts), database.dirtyEntities.count(),
                ]);
                return { data: { logs, workouts, workoutTypes, profile }, conflicts, pendingCount };
            });
            if (!context.isCurrent()) return;
            const changedEntities: CacheChanges['entities'] = [];
            let changed = !this.loaded;
            const previousZone = this.getTimeZone();
            const profileChanged = recordDomainSnapshot(this.profile) !== recordDomainSnapshot(snapshot.data.profile);
            if (profileChanged) changedEntities.push({entityType: 'profile', entityId: 'me'});
            changed ||= profileChanged;
            this.profile = snapshot.data.profile;
            this.timeZone = undefined;
            const zoneChanged = previousZone !== this.getTimeZone();
            for (const type of ['logs', 'workouts', 'workoutTypes'] as const) {
                const cache = (type === 'logs' ? this.logs : type === 'workouts' ? this.workouts : this.types) as EntityCache<WorkoutSet | WorkoutSession | WorkoutType>;
                const rows = snapshot.data[type];
                const ids = full ? rows.map(row => row!.id) : batch.entities.filter(item => item.entityType === type).map(item => item.entityId);
                if (full) {
                    const present = new Set(ids);
                    for (const id of cache.records.keys()) if (!present.has(id)) ids.push(id);
                }
                ids.forEach((id, index) => {
                    const old = cache.records.get(id);
                    const row = rows[index];
                    const domainChanged = cache.put(id, row);
                    if (domainChanged) { changed = true; changedEntities.push({entityType: type, entityId: id}); }
                    if (type === 'workouts') {
                        const workout = row as WorkoutSession | undefined;
                        if (workout && !workout.isDeleted && (workout.status === 'active' || workout.status === 'paused')) this.activeWorkouts.set(id, workout);
                        else this.activeWorkouts.delete(id);
                    }
                    if (type === 'logs' && !full && !zoneChanged) this.indexLog(id, old as WorkoutSet | undefined, row as WorkoutSet | undefined);
                });
            }
            if (full || zoneChanged) this.rebuildLogIndexes();
            const conflictKeys = full ? [...new Set([...this.conflicts.keys(), ...snapshot.conflicts.map(item => item!.key)])] : batch.conflicts;
            const conflictRows = new Map(snapshot.conflicts.flatMap(item => item ? [[item.key, item] as const] : []));
            const changedConflicts: string[] = [];
            for (const key of conflictKeys) {
                const item = conflictRows.get(key);
                if (JSON.stringify(this.conflicts.get(key)) !== JSON.stringify(item)) { changed = true; changedConflicts.push(key); }
                if (item) this.conflicts.set(key, item); else this.conflicts.delete(key);
            }
            const pendingChanged = this.pendingCount !== snapshot.pendingCount;
            this.loaded = true;
            if (full) this.reconcileRequired = false;
            this.pendingCount = snapshot.pendingCount;
            this.notify(changed, pendingChanged, { entities: changedEntities, conflicts: changedConflicts });
            return batch;
        } catch (error) {
            // Failed reads never discard committed changes. New commits remain in their own batch.
            sync.cacheChanges.add(batch);
            if (full) this.reconcileRequired = true;
            if (context.isCurrent()) throw error;
        }
    }
    private indexLog(id: string, old: WorkoutSet | undefined, log: WorkoutSet | undefined, rebuilding = false) {
        this.latest.put(id, log);
        const previousDay = this.logDays.get(id);
        if (!rebuilding && old && log && !log.isDeleted && old.date === log.date && old.workoutId === log.workoutId && previousDay !== undefined) {
            this.logsByDay.get(previousDay)!.set(id, log);
            if (log.workoutId) this.logsByWorkout.get(log.workoutId)!.set(id, log);
            return;
        }
        if (previousDay !== undefined) {
            const bucket = this.logsByDay.get(previousDay)!;
            bucket.delete(id);
            if (!bucket.size) { this.logsByDay.delete(previousDay); if (!rebuilding) this.days.splice(lowerBound(this.days, previousDay), 1); }
            this.logDays.delete(id);
        }
        if (old?.workoutId) {
            const bucket = this.logsByWorkout.get(old.workoutId);
            bucket?.delete(id);
            if (!bucket?.size) this.logsByWorkout.delete(old.workoutId);
        }
        if (!log || log.isDeleted) return;
        if (log.workoutId) {
            let bucket = this.logsByWorkout.get(log.workoutId);
            if (!bucket) this.logsByWorkout.set(log.workoutId, bucket = new Map());
            bucket.set(id, log);
        }
        const instant = new Date(log.date).getTime();
        if (!Number.isFinite(instant)) return;
        const parts = this.dayFormatter!.formatToParts(instant);
        const part = (type: string) => parts.find(p => p.type === type)!.value;
        const key = `${part('year')}-${part('month')}-${part('day')}`;
        let bucket = this.logsByDay.get(key);
        if (!bucket) {
            this.logsByDay.set(key, bucket = new Map());
            if (!rebuilding) this.days.splice(lowerBound(this.days, key), 0, key);
        }
        bucket.set(id, log); this.logDays.set(id, key);
    }
    private rebuildLogIndexes() {
        this.logsByDay.clear(); this.logsByWorkout.clear(); this.logDays.clear(); this.latest.clear();
        this.dayFormatter = new Intl.DateTimeFormat('en', {timeZone: this.getTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit'});
        for (const log of this.logs.records.values()) this.indexLog(log.id, undefined, log, true);
        this.days = [...this.logsByDay.keys()].sort();
    }
    getLogsInDayRange(start: string, end: string): WorkoutSet[] {
        const result: WorkoutSet[] = [];
        for (let index = lowerBound(this.days, start); index < this.days.length && this.days[index] <= end; index++) {
            for (const log of this.logsByDay.get(this.days[index])!.values()) result.push(log);
        }
        return result;
    }
    getLatestLog() { return this.latest.get(); }
    getLogById(id: string) { return this.logs.get(id); }
    getWorkoutById(id: string) { return this.workouts.get(id); }
    getWorkoutTypeById(id: string) { return this.types.get(id); }
    getWorkoutTypes(): WorkoutType[] { return [...this.types.values()].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity)); }
    getLogs(): WorkoutSet[] { return [...this.logs.values()]; }
    getWorkouts(): WorkoutSession[] { return [...this.workouts.values()]; }
    getActiveWorkout() {
        let active: WorkoutSession | undefined;
        for (const workout of this.activeWorkouts.values()) if (!active || workout.id < active.id) active = workout;
        return active;
    }
    getProfile() { return this.profile; }
    getTimeZone() { return this.timeZone ??= accountTimeZone(this.profile?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone); }
    getConflicts() { return [...this.conflicts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.key.localeCompare(a.key)); }
    getWorkoutDuration(workout: WorkoutSession) { return sessionDurationSeconds(workout, [...(this.logsByWorkout.get(workout.id)?.values() ?? [])]) / 60; }
    getProfileIdentifier() { return this.profile?.username || this.profile?.telegramUsername || (this.profile?.telegramUserId ? `id_${this.profile.telegramUserId}` : ''); }
    isFriend(identifier: string) { return this.profile?.friends?.some(friend => friend.identifier === identifier) ?? false; }
}
