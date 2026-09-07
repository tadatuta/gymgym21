import { SyncError, retryDelay } from '../services/sync-error';
import { domainSnapshot } from './domain-snapshot';
import type { Table } from 'dexie';
import { createBackup, readBackup, type BackupMode } from './backup';
import {
    AppData,
    PublicProfileData,
    SyncConflictRecord,
    SyncEntityType,
    SyncItem,
    UserProfile,
    WorkoutSession,
    WorkoutSet,
    WorkoutType,
} from '../types';
import { SyncService } from '../services/sync';
import { activateAccountDatabase, db, getActiveStorageKey, captureAccountContext, closeActiveDatabase } from '../db';
import {
    authorizedApiFetch,
    getCurrentUser,
    hasVerifiedOnlineAccount,
    resolveApiUrl,
} from '../auth';
import { createEntityId } from '../utils/entity-id';

const LEGACY_LOCAL_STORAGE_KEY = 'gym_twa_data';
const LEGACY_LOCAL_STORAGE_OWNER_KEY = 'gym21_legacy_local_storage_owner_v1';
const LEGACY_AI_RESULTS_KEY = 'gym_ai_results';
const LEGACY_AI_OWNER_KEY = 'gym21_legacy_ai_owner_v1';
const PROFILE_ID = 'me';

function createDefaultWorkoutTypes(): WorkoutType[] {
    const now = new Date().toISOString();
    return [
        { id: 'default-bench-press', name: 'Жим лежа', order: 1, updatedAt: now },
        { id: 'default-squat', name: 'Приседания', order: 2, updatedAt: now },
        { id: 'default-deadlift', name: 'Становая тяга', order: 3, updatedAt: now },
    ];
}

function emptyData(): AppData {
    return {
        workoutTypes: [],
        logs: [],
        workouts: [],
    };
}

function cloneWorkout(workout: WorkoutSession): WorkoutSession {
    return {
        ...workout,
        pauseIntervals: workout.pauseIntervals.map((interval) => ({ ...interval })),
    };
}

export type SyncStatus = 'idle' | 'saving' | 'success' | 'error';

interface StorageServiceOptions {
    autoInit?: boolean;
    syncDebounceMs?: number;
    enableBroadcast?: boolean;
}

interface MutationResult<T> {
    value: T;
    dirty: Array<{ entityType: SyncEntityType; entityId: string }>;
}

interface CachedAiResults {
    general: string | null;
    plan: string | null;
}

type PublicProfileWithCacheMetadata = PublicProfileData & {
    cacheMetadata?: {
        cached: boolean;
        cachedAt: string;
    };
};

export class StorageService {
    private onUpdateCallback?: () => void;
    private onSyncStatusChangeCallback?: (status: SyncStatus) => void;
    private onUnauthorizedCallback?: () => void;
    private status: SyncStatus = 'idle';
    private readonly syncDebounceMs: number;
    private syncTimer: ReturnType<typeof setTimeout> | undefined;
    private syncInFlight = false;
    private syncController?: AbortController;
    private successTimer?: ReturnType<typeof setTimeout>;
    private retryAttempt = 0;
    private retryAt = 0;
    private syncFailure?: SyncError;
    private pendingCount = 0;

    getSyncState() { return { pendingCount: this.pendingCount, error: this.syncFailure, retryAt: this.retryAt }; }

    private resetSyncRecovery() {
        clearTimeout(this.successTimer);
        this.successTimer = undefined;
        this.syncController?.abort();
        this.syncController = undefined;
        this.retryAttempt = 0;
        this.retryAt = 0;
        this.syncFailure = undefined;
        this.pendingCount = 0;
    }

    private syncQueued = false;
    private initialized = false;
    private activeStorageKey: string | null = null;
    private broadcastChannel?: BroadcastChannel;
    private readonly enableBroadcast: boolean;
    private cache: AppData = emptyData();
    private cacheStorageKey: string | null = null;
    private conflicts: SyncConflictRecord[] = [];

    private readonly handleAuthChange = () => {
        this.clearScheduledSync();
        this.resetSyncRecovery();
        this.disconnectBroadcastChannel();
        this.initialized = false;
        this.activeStorageKey = null;
        this.syncInFlight = false;
        this.syncQueued = false;
        this.cache = emptyData();
        this.conflicts = [];
        closeActiveDatabase();
        this.onUnauthorizedCallback?.();
    };

    private readonly handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            this.scheduleSync(0);
            void this.reloadCache();
        }
    };

    constructor(options: StorageServiceOptions = {}) {
        this.syncDebounceMs = options.syncDebounceMs ?? 1500;
        this.enableBroadcast = options.enableBroadcast ?? true;
        this.attachSyncTriggers();
        if (typeof window !== 'undefined') window.addEventListener('gym21-auth-changed', this.handleAuthChange);

        if (options.autoInit) {
            console.warn('StorageService now requires activate(storageKey); autoInit is ignored.');
        }
    }

    async activate(storageKey: string) {
        if (this.initialized && this.activeStorageKey === storageKey && getActiveStorageKey() === storageKey) {
            await this.reloadCache();
            return;
        }

        this.clearScheduledSync();
        this.resetSyncRecovery();
        this.disconnectBroadcastChannel();
        await activateAccountDatabase(storageKey);
        const context = captureAccountContext();
        this.syncInFlight = false;
        this.syncQueued = false;
        this.activeStorageKey = storageKey;
        this.initialized = true;
        this.connectBroadcastChannel(storageKey);

        await this.migrateFromLocalStorage(storageKey);
        context.assertCurrent();
        await this.migrateLegacyAiResults(storageKey);
        context.assertCurrent();
        await SyncService.bootstrapDirtyState();
        context.assertCurrent();
        await this.reloadCache();
    }

    isActive(): boolean {
        return this.initialized && this.activeStorageKey !== null;
    }

    getStorageKey(): string | null {
        return this.activeStorageKey;
    }

    dispose() {
        this.initialized = false;
        this.clearScheduledSync();
        this.resetSyncRecovery();
        this.disconnectBroadcastChannel();
        if (typeof window !== 'undefined') {
            window.removeEventListener('gym21-auth-changed', this.handleAuthChange);
            document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        }
    }

    private assertActive() {
        if (!this.isActive()) {
            throw new Error('Local storage is not initialized for an account');
        }
    }

    private async migrateFromLocalStorage(storageKey: string) {
        const json = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
        if (!json) {
            return;
        }

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

            await db.transaction(
                'rw',
                [db.workoutTypes, db.logs, db.workouts, db.profile, db.dirtyEntities],
                async () => {
                    if (workoutTypes.length > 0) await db.workoutTypes.bulkPut(workoutTypes);
                    if (logs.length > 0) await db.logs.bulkPut(logs);
                    if (workouts.length > 0) await db.workouts.bulkPut(workouts);
                    if (profile) await db.profile.put(profile);
                    await SyncService.markDirtyMany([
                        ...workoutTypes.map((item) => ({ entityType: 'workoutTypes' as const, entityId: item.id })),
                        ...logs.map((item) => ({ entityType: 'logs' as const, entityId: item.id })),
                        ...workouts.map((item) => ({ entityType: 'workouts' as const, entityId: item.id })),
                        ...(profile ? [{ entityType: 'profile' as const, entityId: PROFILE_ID }] : []),
                    ]);
                },
            );
            localStorage.setItem(LEGACY_LOCAL_STORAGE_OWNER_KEY, storageKey);
        } catch (error) {
            console.error('Legacy localStorage migration failed', error);
        }
    }

    private async migrateLegacyAiResults(storageKey: string) {
        if (await db.aiResultCache.count() > 0) {
            return;
        }

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
                await db.aiResultCache.bulkPut(records);
                localStorage.setItem(LEGACY_AI_OWNER_KEY, storageKey);
            }
        } catch {
            // Ignore malformed legacy AI cache values.
        }
    }

    onUpdate(callback: () => void) {
        this.onUpdateCallback = callback;
    }

    onSyncStatusChange(callback: (status: SyncStatus) => void) {
        this.onSyncStatusChangeCallback = callback;
    }

    onUnauthorized(callback: () => void) {
        this.onUnauthorizedCallback = callback;
    }

    private setStatus(status: SyncStatus) {
        this.status = status;
        this.onSyncStatusChangeCallback?.(status);

        clearTimeout(this.successTimer);
        this.successTimer = undefined;
        if (status === 'success') {
            this.successTimer = setTimeout(() => {
                if (this.status === 'success') {
                    this.setStatus('idle');
                }
            }, 2000);
        }
    }

    private attachSyncTriggers() {
        if (typeof window === 'undefined') {
            return;
        }

        document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    private connectBroadcastChannel(storageKey: string) {
        if (!this.enableBroadcast || typeof BroadcastChannel === 'undefined') {
            return;
        }

        this.broadcastChannel = new BroadcastChannel(`gym21:${storageKey}`);
        this.broadcastChannel.addEventListener('message', () => {
            void this.reloadCache();
        });
    }

    private disconnectBroadcastChannel() {
        this.broadcastChannel?.close();
        this.broadcastChannel = undefined;
    }

    private broadcastUpdate() {
        this.broadcastChannel?.postMessage({ type: 'local-data-updated' });
    }

    private clearScheduledSync() {
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
            this.syncTimer = undefined;
        }
    }

    scheduleSync(delay = this.syncDebounceMs) {
        if (!this.isActive() || !hasVerifiedOnlineAccount(this.activeStorageKey)) {
            this.setStatus('idle');
            return;
        }

        this.clearScheduledSync();
        this.syncTimer = setTimeout(() => {
            this.syncTimer = undefined;
            void this.sync();
        }, Math.min(2_147_483_647, Math.max(delay, this.retryAt - Date.now())));
    }

    async sync() {
        if (!this.isActive() || !hasVerifiedOnlineAccount(this.activeStorageKey)) {
            this.setStatus('idle');
            return;
        }

        if (Date.now() < this.retryAt) {
            this.scheduleSync(this.retryAt - Date.now());
            return;
        }
        this.clearScheduledSync();
        if (this.syncInFlight) {
            this.syncQueued = true;
            return;
        }

        const context = captureAccountContext();
        this.syncInFlight = true;
        const controller = new AbortController();
        this.syncController = controller;
        let nextDelay = 0;
        try {
            const lockAcquired = await this.withSyncLock(async () => {
                context.assertCurrent();
                this.setStatus('saving');
                const result = await SyncService.sync(controller.signal);
                if (controller.signal.aborted) return;
                this.retryAttempt = 0;
                this.retryAt = 0;
                this.syncFailure = undefined;
                context.assertCurrent();
                await this.reloadCache();
                context.assertCurrent();
                const seededDefaults = result.hasMore
                    ? false
                    : await this.ensureDefaultWorkoutTypesAfterBootstrap();
                context.assertCurrent();
                this.setStatus('success');
                this.broadcastUpdate();

                if (seededDefaults) {
                    this.syncQueued = true;
                }
                if (result.hasMore) {
                    this.syncQueued = true;
                }
                if (result.conflicts > 0) {
                    console.warn(`Sync preserved ${result.conflicts} conflict(s) for review.`);
                }
            });
            if (!lockAcquired) {
                this.syncQueued = true;
                nextDelay = 250;
            }
        } catch (error: unknown) {
            if (!context.isCurrent() || controller.signal.aborted) return;
            this.syncFailure = error instanceof SyncError ? error
                : new SyncError(error instanceof Error ? error.message : 'Ошибка локальной синхронизации', 'LOCAL_ERROR');
            this.syncQueued = false;
            if (this.syncFailure.retryable && navigator.onLine) {
                nextDelay = Math.max(retryDelay(this.retryAttempt++), this.syncFailure.retryAfterMs);
                this.retryAt = Date.now() + nextDelay;
                this.syncQueued = true;
            }
            console.warn('Sync interrupted', { code: this.syncFailure.code, retryAt: this.retryAt, pendingCount: this.pendingCount });
            this.setStatus(this.syncFailure.code === 'OFFLINE' ? 'idle' : 'error');
        } finally {
            if (context.isCurrent() && this.syncController === controller) {
                this.syncController = undefined;
                this.syncInFlight = false;
                if (this.syncQueued) {
                    this.syncQueued = false;
                    this.scheduleSync(nextDelay);
                }
            }
        }
    }

    private async withSyncLock(operation: () => Promise<void>): Promise<boolean> {
        const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
        if (!lockManager || !this.activeStorageKey) {
            await operation();
            return true;
        }

        return lockManager.request(
            `gym21-sync:${this.activeStorageKey}`,
            { ifAvailable: true },
            async (lock) => {
                if (lock) {
                    await operation();
                    return true;
                }
                return false;
            },
        );
    }

    private async ensureDefaultWorkoutTypesAfterBootstrap(): Promise<boolean> {
        if (await db.workoutTypes.count() > 0) {
            return false;
        }

        const defaults = createDefaultWorkoutTypes();
        await db.transaction('rw', [db.workoutTypes, db.dirtyEntities], async () => {
            await db.workoutTypes.bulkPut(defaults);
            await SyncService.markDirtyMany(
                defaults.map((item) => ({ entityType: 'workoutTypes', entityId: item.id })),
            );
        });
        await this.reloadCache();
        return true;
    }

    private async commitMutation<T>(
        tables: Table[],
        mutation: () => Promise<MutationResult<T>>,
    ): Promise<T> {
        this.assertActive();
        let result!: MutationResult<T>;
        await db.transaction('rw', [...tables, db.dirtyEntities], async () => {
            result = await mutation();
            await SyncService.markDirtyMany(result.dirty);
        });
        await this.reloadCache();
        this.broadcastUpdate();
        this.scheduleSync();
        return result.value;
    }

    async reloadCache() {
        if (!this.isActive()) {
            return;
        }

        const context = captureAccountContext();
        const [data, conflicts, pendingCount] = await Promise.all([
            SyncService.readAll(),
            db.syncConflicts.orderBy('createdAt').reverse().toArray(),
            db.dirtyEntities.count(),
        ]);
        if (!context.isCurrent()) return;
        const changed = this.cacheStorageKey !== context.storageKey
            || domainSnapshot(this.cache) !== domainSnapshot(data)
            || JSON.stringify(this.conflicts) !== JSON.stringify(conflicts);
        const pendingChanged = this.pendingCount !== pendingCount;
        this.pendingCount = pendingCount;
        this.cacheStorageKey = context.storageKey;
        this.cache = data;
        this.conflicts = conflicts;
        if (changed) this.onUpdateCallback?.();
        if (pendingChanged) this.onSyncStatusChangeCallback?.(this.status);
    }

    getWorkoutTypes(): WorkoutType[] {
        return this.cache.workoutTypes
            .filter((item) => !item.isDeleted)
            .sort((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity));
    }

    getLogs(): WorkoutSet[] {
        return this.cache.logs.filter((item) => !item.isDeleted);
    }

    getWorkouts(): WorkoutSession[] {
        return this.cache.workouts.filter((item) => !item.isDeleted);
    }

    getActiveWorkout(): WorkoutSession | undefined {
        return this.cache.workouts.find(
            (workout) => !workout.isDeleted && (workout.status === 'active' || workout.status === 'paused'),
        );
    }

    getProfile(): UserProfile | undefined {
        return this.cache.profile;
    }

    getConflicts(): SyncConflictRecord[] {
        return [...this.conflicts];
    }

    async addWorkoutType(name: string, category: 'strength' | 'time' = 'strength'): Promise<WorkoutType> {
        const types = this.getWorkoutTypes();
        const maxOrder = types.length > 0 ? Math.max(...types.map((item) => item.order ?? 0)) : 0;
        const newType: WorkoutType = {
            id: createEntityId(),
            name,
            category,
            order: maxOrder + 1,
            updatedAt: new Date().toISOString(),
        };

        return this.commitMutation([db.workoutTypes], async () => {
            await db.workoutTypes.put(newType);
            return {
                value: newType,
                dirty: [{ entityType: 'workoutTypes', entityId: newType.id }],
            };
        });
    }

    async deleteWorkoutType(id: string): Promise<void> {
        await this.commitMutation([db.workoutTypes], async () => {
            const existing = await db.workoutTypes.get(id);
            if (!existing) return { value: undefined, dirty: [] };
            await db.workoutTypes.put({
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
        await this.commitMutation([db.workoutTypes], async () => {
            const existing = await db.workoutTypes.get(id);
            if (!existing) return { value: undefined, dirty: [] };
            await db.workoutTypes.put({
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

        return this.commitMutation([db.workouts], async () => {
            const activeWorkouts = await db.workouts.where('status').anyOf('active', 'paused').toArray();
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
                await db.workouts.put(finished);
            }

            await db.workouts.put(newWorkout);
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
        await this.commitMutation([db.workouts], async () => {
            const active = (await db.workouts.where('status').anyOf('active', 'paused').first());
            if (!active) return { value: undefined, dirty: [] };
            const now = new Date().toISOString();
            const changed = change(cloneWorkout(active), now);
            if (!changed) return { value: undefined, dirty: [] };
            changed.updatedAt = now;
            await db.workouts.put(changed);
            return {
                value: undefined,
                dirty: [{ entityType: 'workouts', entityId: changed.id }],
            };
        });
    }

    async updateWorkout(id: string, updates: { name?: string; startTime?: string; endTime?: string }): Promise<void> {
        await this.commitMutation([db.workouts], async () => {
            const workout = await db.workouts.get(id);
            if (!workout) return { value: undefined, dirty: [] };
            const next = cloneWorkout(workout);
            if (updates.name !== undefined) next.name = updates.name || undefined;
            if (updates.startTime) next.startTime = updates.startTime;
            if (updates.endTime) next.endTime = updates.endTime;
            next.updatedAt = new Date().toISOString();
            await db.workouts.put(next);
            return {
                value: undefined,
                dirty: [{ entityType: 'workouts', entityId: id }],
            };
        });
    }

    getWorkoutDuration(workout: WorkoutSession): number {
        const start = new Date(workout.startTime).getTime();
        const end = workout.endTime ? new Date(workout.endTime).getTime() : Date.now();
        let sessionDuration = end - start;

        workout.pauseIntervals.forEach((interval) => {
            const pauseStart = new Date(interval.start).getTime();
            const pauseEnd = interval.end
                ? new Date(interval.end).getTime()
                : (workout.status === 'paused' ? Date.now() : end);
            if (pauseEnd > pauseStart) {
                sessionDuration -= pauseEnd - pauseStart;
            }
        });

        const sessionMinutes = Math.floor(Math.max(0, sessionDuration) / 60000);
        const exercisesDuration = this.cache.logs
            .filter((log) => log.workoutId === workout.id && !log.isDeleted)
            .reduce((total, log) => total + (log.duration || 0), 0);
        return Math.max(sessionMinutes, exercisesDuration);
    }

    private async ensureActiveWorkoutInTransaction(now: string): Promise<string> {
        const active = await db.workouts.where('status').anyOf('active', 'paused').first();
        if (active) return active.id;

        const today = now.slice(0, 10);
        const workouts = await db.workouts.toArray();
        const lastWorkout = workouts
            .filter((workout) => !workout.isDeleted && workout.startTime.startsWith(today))
            .sort((left, right) => right.startTime.localeCompare(left.startTime))[0];

        if (lastWorkout && !lastWorkout.isManual && lastWorkout.status === 'finished') {
            await db.workouts.put({
                ...cloneWorkout(lastWorkout),
                endTime: now,
                updatedAt: now,
            });
            return lastWorkout.id;
        }

        const id = createEntityId();
        await db.workouts.put({
            id,
            startTime: now,
            endTime: now,
            status: 'finished',
            isManual: false,
            pauseIntervals: [],
            updatedAt: now,
        });
        return id;
    }

    private async updateImplicitWorkoutBoundsInTransaction(workoutId: string) {
        const workout = await db.workouts.get(workoutId);
        if (!workout || workout.isManual) return;
        const activeLogs = (await db.logs.where('workoutId').equals(workoutId).toArray())
            .filter((log) => !log.isDeleted)
            .sort((left, right) => left.date.localeCompare(right.date));
        if (activeLogs.length === 0) return;

        await db.workouts.put({
            ...cloneWorkout(workout),
            startTime: activeLogs[0].date,
            endTime: activeLogs.at(-1)!.date,
            status: 'finished',
            updatedAt: new Date().toISOString(),
        });
    }

    async addLog(log: Omit<WorkoutSet, 'id' | 'date' | 'workoutId' | 'updatedAt' | 'isDeleted'>): Promise<WorkoutSet> {
        return this.commitMutation([db.workouts, db.logs], async () => {
            const now = new Date().toISOString();
            const workoutId = await this.ensureActiveWorkoutInTransaction(now);
            const newLog: WorkoutSet = {
                ...log,
                id: createEntityId(),
                date: now,
                workoutId,
                updatedAt: now,
            };
            await db.logs.put(newLog);
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
        await this.commitMutation([db.workouts, db.logs], async () => {
            const log = await db.logs.get(id);
            if (!log) return { value: undefined, dirty: [] };
            const deleted = {
                ...log,
                isDeleted: true,
                updatedAt: new Date().toISOString(),
            };
            await db.logs.put(deleted);
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
        await this.commitMutation([db.logs], async () => {
            const next = { ...updatedLog, updatedAt: new Date().toISOString() };
            await db.logs.put(next);
            return {
                value: undefined,
                dirty: [{ entityType: 'logs', entityId: next.id }],
            };
        });
    }

    getProfileIdentifier(): string {
        const profile = this.cache.profile;
        if (profile?.username) return profile.username;
        if (profile?.telegramUsername) return profile.telegramUsername;
        return profile?.telegramUserId ? `id_${profile.telegramUserId}` : '';
    }

    async updateProfileSettings(settings: Partial<UserProfile>): Promise<void> {
        await this.commitMutation([db.profile], async () => {
            const authUser = getCurrentUser();
            const existing = await db.profile.get(PROFILE_ID);
            const now = new Date().toISOString();
            const base: UserProfile = existing
                ? { ...existing, friends: [...(existing.friends ?? [])] }
                : {
                    id: PROFILE_ID,
                    isPublic: false,
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
            await db.profile.put(merged);
            return {
                value: undefined,
                dirty: [{ entityType: 'profile', entityId: PROFILE_ID }],
            };
        });
    }

    async addFriend(friend: { identifier: string; displayName: string; photoUrl?: string }): Promise<void> {
        const profile = this.cache.profile;
        if (!profile || profile.friends?.some((entry) => entry.identifier === friend.identifier)) return;
        await this.updateProfileSettings({
            friends: [
                ...(profile.friends || []),
                { ...friend, addedAt: new Date().toISOString() },
            ],
        });
    }

    async removeFriend(identifier: string): Promise<void> {
        const profile = this.cache.profile;
        if (!profile) return;
        await this.updateProfileSettings({
            friends: (profile.friends || []).filter((friend) => friend.identifier !== identifier),
        });
    }

    isFriend(identifier: string): boolean {
        return this.cache.profile?.friends?.some((friend) => friend.identifier === identifier) ?? false;
    }

    async updateWorkoutTypeOrder(ids: string[]): Promise<void> {
        await this.commitMutation([db.workoutTypes], async () => {
            const now = new Date().toISOString();
            const updates: WorkoutType[] = [];
            ids.forEach((id, order) => {
                const type = this.cache.workoutTypes.find((entry) => entry.id === id);
                if (type) {
                    updates.push({ ...type, order, updatedAt: now });
                }
            });
            if (updates.length > 0) await db.workoutTypes.bulkPut(updates);
            return {
                value: undefined,
                dirty: updates.map((entry) => ({ entityType: 'workoutTypes', entityId: entry.id })),
            };
        });
    }

    async getPublicProfile(identifier: string): Promise<PublicProfileWithCacheMetadata | null> {
        this.assertActive();
        const context = captureAccountContext();
        const db = context.database;
        const normalizedIdentifier = identifier.trim().replace(/^@/, '').toLowerCase();
        if (!normalizedIdentifier) return null;

        try {
            const response = await fetch(resolveApiUrl(`/profiles/${encodeURIComponent(identifier)}`), { signal: context.signal });
            context.assertCurrent();
            if (response.ok) {
                const payload = await response.json() as PublicProfileData;
                context.assertCurrent();
                const cachedAt = new Date().toISOString();
                await db.publicProfileCache.put({
                    identifier: normalizedIdentifier,
                    payload,
                    cachedAt,
                });
                return {
                    ...payload,
                    cacheMetadata: { cached: false, cachedAt },
                };
            }
            if (response.status === 404 || response.status === 403) {
                await db.publicProfileCache.delete(normalizedIdentifier);
                return null;
            }
            throw new Error('Public profile request failed');
        } catch {
            // Fall through to the account-scoped IndexedDB cache.
        }

        context.assertCurrent();
        const cached = await db.publicProfileCache.get(normalizedIdentifier);
        context.assertCurrent();
        return cached
            ? {
                ...cached.payload,
                cacheMetadata: { cached: true, cachedAt: cached.cachedAt },
            }
            : null;
    }

    async readCachedAIResults(): Promise<CachedAiResults> {
        this.assertActive();
        const records = await db.aiResultCache.toArray();
        return {
            general: records.find((record) => record.type === 'general')?.markdown ?? null,
            plan: records.find((record) => record.type === 'plan')?.markdown ?? null,
        };
    }

    async getAIRecommendation(
        type: 'general' | 'plan',
        options?: { period?: 'day' | 'week'; allowNewExercises?: boolean },
    ): Promise<string> {
        const context = captureAccountContext();
        const db = context.database;
        if (!hasVerifiedOnlineAccount(this.activeStorageKey)) {
            throw new Error('Новая рекомендация требует подключения к интернету');
        }

        const response = await authorizedApiFetch('/me/ai/recommendations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, options }),
        }, context);
        context.assertCurrent();
        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('Unauthorized');
            }
            throw new Error('AI Generation Failed');
        }

        const data = await response.json();
        context.assertCurrent();
        if (data?.format !== 'markdown' || typeof data?.recommendation !== 'string') {
            throw new Error('Invalid AI response');
        }

        await db.aiResultCache.put({
            type,
            markdown: data.recommendation,
            updatedAt: new Date().toISOString(),
        });
        context.assertCurrent();
        this.broadcastUpdate();
        return data.recommendation;
    }

    async restoreConflictLocal(key: string): Promise<void> {
        const conflict = await db.syncConflicts.get(key);
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
            ? db.profile
            : conflict.entityType === 'workoutTypes'
                ? db.workoutTypes
                : conflict.entityType === 'workouts'
                    ? db.workouts
                    : db.logs;

        await db.transaction('rw', [table, db.dirtyEntities, db.syncConflicts], async () => {
            switch (conflict.entityType) {
                case 'profile':
                    await db.profile.put(rebased as UserProfile);
                    break;
                case 'workoutTypes':
                    await db.workoutTypes.put(rebased as WorkoutType);
                    break;
                case 'workouts':
                    await db.workouts.put(rebased as WorkoutSession);
                    break;
                case 'logs':
                    await db.logs.put(rebased as WorkoutSet);
                    break;
            }
            await SyncService.markDirty(conflict.entityType, conflict.entityId);
            await db.syncConflicts.delete(key);
        });
        await this.reloadCache();
        this.broadcastUpdate();
        this.scheduleSync();
    }

    async dismissConflict(key: string): Promise<void> {
        await db.syncConflicts.delete(key);
        await this.reloadCache();
        this.broadcastUpdate();
    }

    async exportData(): Promise<AppData> {
        this.assertActive();
        return SyncService.readAll();
    }

    async exportBackup() {
        return createBackup(await this.exportData());
    }

    async importData(input: unknown, mode: BackupMode): Promise<void> {
        this.assertActive();
        const context = captureAccountContext();
        const database = context.database;
        const data = readBackup(input);
        if (Date.now() < this.retryAt) throw new Error('Сервер попросил подождать. Повторите импорт после автоматической синхронизации');
        this.clearScheduledSync();
        if (this.syncInFlight) throw new Error('Дождитесь завершения синхронизации и повторите импорт');
        if (mode !== 'merge' && mode !== 'replace') throw new Error('Выберите режим импорта');
        if (navigator.onLine) {
            this.syncInFlight = true;
            try {
                const acquired = await this.withSyncLock(() => new SyncService().importBackup(data, mode));
                if (!acquired) throw new Error('Синхронизация выполняется в другой вкладке. Повторите импорт');
            } finally {
                if (context.isCurrent()) {
                    this.syncInFlight = false;
                    // Preflight may have pulled changes even if the import itself failed.
                    await this.reloadCache();
                    context.assertCurrent();
                    this.broadcastUpdate();
                    if (this.syncQueued) {
                        this.syncQueued = false;
                        this.scheduleSync(0);
                    }
                }
            }
        } else {
            if (mode === 'replace') throw new Error('Замена данных требует подключения к серверу. Объединение доступно офлайн');
            const sync = new SyncService();
            await database.transaction('rw', [database.workouts, database.logs, database.workoutTypes, database.profile, database.dirtyEntities], async () => {
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
        await database.aiResultCache.clear();
        context.assertCurrent();
        await this.reloadCache();
        this.broadcastUpdate();
        this.scheduleSync(0);
    }

}

export const storage = new StorageService({ autoInit: false });
