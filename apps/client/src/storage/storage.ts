import type { CacheChanges } from './cache-changes';
import type { UserProfile, WorkoutSession, WorkoutSet } from '../types';
import { activateAccountDatabase, captureAccountContext, closeActiveDatabase } from '../db';
import { AccountRepository } from './account-repository';
import { AccountReads } from './account-reads';
import { DomainMutations } from './domain-mutations';
import { SyncCoordinator, type SyncStatus } from './sync-coordinator';
import { RemoteReads, getPublicProfile } from './remote-reads';
import { migrateFromLocalStorage, migrateLegacyAiResults } from './legacy-migration';
import { importAccountBackup } from './backup-service';
import { createBackup, type BackupMode } from './backup';
import { accountTimeZone } from '../utils/training-time';
import { sessionDurationSeconds } from '../utils/duration';
export { PublicProfileUnavailableError } from './remote-reads';
export type { SyncStatus } from './sync-coordinator';
interface StorageServiceOptions { syncDebounceMs?: number; enableBroadcast?: boolean; }
interface AccountServices {
    repository: AccountRepository;
    reads: AccountReads;
    mutations: DomainMutations;
    coordinator: SyncCoordinator;
    remote: RemoteReads;
}

/** UI-compatible composition facade. Each async call binds to one account's services. */
export class StorageService {
    private account?: AccountServices;
    private activation = 0;
    private onUpdateCallback?: (changes?: CacheChanges) => void;
    private onSyncStatusChangeCallback?: (status: SyncStatus) => void;
    private onUnauthorizedCallback?: () => void;
    private readonly handleAuthChange = () => {
        this.releaseAccount();
        closeActiveDatabase();
        this.onUnauthorizedCallback?.();
    };
    constructor(private readonly options: StorageServiceOptions = {}) {
        if (typeof window !== 'undefined') window.addEventListener('gym21-auth-changed', this.handleAuthChange);
    }
    private releaseAccount() {
        this.activation += 1;
        this.account?.coordinator.dispose();
        this.account?.repository.dispose();
        this.account = undefined;
    }
    private requireAccount() {
        if (!this.account) throw new Error('Local storage is not initialized for an account');
        this.account.repository.context.assertCurrent();
        return this.account;
    }
    async activate(storageKey: string) {
        if (this.isActive() && this.getStorageKey() === storageKey) { await this.reloadCache(); return; }
        this.releaseAccount();
        const activation = this.activation;
        await activateAccountDatabase(storageKey);
        if (activation !== this.activation) throw new Error('Stale storage activation');
        const repository = new AccountRepository(captureAccountContext());
        const current = () => this.account?.repository === repository && repository.context.isCurrent();
        const reads = new AccountReads(repository, (changed, pendingChanged, changes) => {
            if (!current()) return;
            if (changed) this.onUpdateCallback?.(changes);
            if (current() && pendingChanged) this.onSyncStatusChangeCallback?.(coordinator.status);
        });
        const coordinator = new SyncCoordinator(repository, reads, status => {
            if (current()) this.onSyncStatusChangeCallback?.(status);
        }, this.options.syncDebounceMs ?? 1500, this.options.enableBroadcast ?? true);
        const mutations = new DomainMutations(repository, reads, async () => {
            repository.context.assertCurrent();
            const changes = await reads.flush();
            repository.context.assertCurrent();
            coordinator.broadcastUpdate(changes);
            coordinator.scheduleSync();
        });
        this.account = { repository, reads, coordinator, mutations, remote: new RemoteReads(repository, coordinator) };
        await migrateFromLocalStorage(repository, storageKey);
        repository.context.assertCurrent();
        await migrateLegacyAiResults(repository, storageKey);
        repository.context.assertCurrent();
        await repository.sync.bootstrapDirtyState();
        repository.context.assertCurrent();
        await reads.reload();
    }
    dispose() {
        this.releaseAccount();
        if (typeof window !== 'undefined') window.removeEventListener('gym21-auth-changed', this.handleAuthChange);
    }
    isActive() { return !!this.account?.repository.context.isCurrent(); }
    getStorageKey() { return this.isActive() ? this.account!.repository.context.storageKey : null; }
    getSyncState() { return (this.isActive() ? this.account?.coordinator.getSyncState() : undefined) ?? { pendingCount: 0, error: undefined, retryAt: 0 }; }
    scheduleSync(delay?: number) { this.account?.coordinator.scheduleSync(delay); }
    async sync() { return this.account?.coordinator.sync(); }
    async reloadCache() { if (this.isActive()) await this.requireAccount().reads.reload(); }
    onUpdate(callback: (changes?: CacheChanges) => void) {
        this.onUpdateCallback = callback;
        return () => {
            if (this.onUpdateCallback === callback) this.onUpdateCallback = undefined;
        };
    }

    onSyncStatusChange(callback: (status: SyncStatus) => void) {
        this.onSyncStatusChangeCallback = callback;
        return () => {
            if (this.onSyncStatusChangeCallback === callback) this.onSyncStatusChangeCallback = undefined;
        };
    }

    onUnauthorized(callback: () => void) {
        this.onUnauthorizedCallback = callback;
        return () => {
            if (this.onUnauthorizedCallback === callback) this.onUnauthorizedCallback = undefined;
        };
    }
    async addWorkoutType(name: string, category: 'strength' | 'time' = 'strength') { return this.requireAccount().mutations.addWorkoutType(name, category); }
    async deleteWorkoutType(id: string) { return this.requireAccount().mutations.deleteWorkoutType(id); }
    async updateWorkoutType(id: string, name: string, category?: 'strength' | 'time') { return this.requireAccount().mutations.updateWorkoutType(id, name, category); }
    async startWorkout(name?: string) { return this.requireAccount().mutations.startWorkout(name); }
    async pauseWorkout() { return this.requireAccount().mutations.pauseWorkout(); }
    async resumeWorkout() { return this.requireAccount().mutations.resumeWorkout(); }
    async finishWorkout() { return this.requireAccount().mutations.finishWorkout(); }
    async updateWorkout(id: string, updates: { name?: string; startTime?: string; endTime?: string }) { return this.requireAccount().mutations.updateWorkout(id, updates); }
    async addLog(log: Omit<WorkoutSet, 'id' | 'date' | 'workoutId' | 'updatedAt' | 'isDeleted'>) { return this.requireAccount().mutations.addLog(log); }
    async deleteLog(id: string) { return this.requireAccount().mutations.deleteLog(id); }
    async updateLog(updatedLog: WorkoutSet) { return this.requireAccount().mutations.updateLog(updatedLog); }
    async updateProfileSettings(settings: Partial<UserProfile>) { return this.requireAccount().mutations.updateProfileSettings(settings); }
    async addFriend(friend: { identifier: string; displayName: string; photoUrl?: string }) { return this.requireAccount().mutations.addFriend(friend); }
    async removeFriend(identifier: string) { return this.requireAccount().mutations.removeFriend(identifier); }
    async updateWorkoutTypeOrder(ids: string[]) { return this.requireAccount().mutations.updateWorkoutTypeOrder(ids); }
    async restoreConflictLocal(key: string) { return this.requireAccount().mutations.restoreConflictLocal(key); }
    async dismissConflict(key: string) { return this.requireAccount().mutations.dismissConflict(key); }
    private activeReads() { return this.isActive() ? this.account?.reads : undefined; }
    getWorkoutTypes() { return this.activeReads()?.getWorkoutTypes() ?? []; }
    getLogsInDayRange(start: string, end: string) { return this.activeReads()?.getLogsInDayRange(start, end) ?? []; }
    getLatestLog() { return this.activeReads()?.getLatestLog(); }
    getLogById(id: string) { return this.activeReads()?.getLogById(id); }
    getWorkoutById(id: string) { return this.activeReads()?.getWorkoutById(id); }
    getWorkoutTypeById(id: string) { return this.activeReads()?.getWorkoutTypeById(id); }
    getLogs() { return this.activeReads()?.getLogs() ?? []; }
    getWorkouts() { return this.activeReads()?.getWorkouts() ?? []; }
    getActiveWorkout() { return this.activeReads()?.getActiveWorkout() ?? undefined; }
    getProfile() { return this.activeReads()?.getProfile() ?? undefined; }
    getConflicts() { return this.activeReads()?.getConflicts() ?? []; }
    getProfileIdentifier() { return this.activeReads()?.getProfileIdentifier() ?? ''; }
    getTimeZone() { return this.activeReads()?.getTimeZone() ?? accountTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone); }
    getWorkoutDuration(workout: WorkoutSession) { return this.activeReads()?.getWorkoutDuration(workout) ?? sessionDurationSeconds(workout) / 60; }
    isFriend(identifier: string) { return this.activeReads()?.isFriend(identifier) ?? false; }
    getPublicProfile(identifier: string, cursor?: string) { return getPublicProfile(identifier, this.account?.repository, cursor); }
    async readCachedAIResults() { return this.requireAccount().remote.readCachedAIResults(); }
    async getAIRecommendation(type: 'general' | 'plan', options?: { period?: 'day' | 'week'; allowNewExercises?: boolean }) {
        return this.requireAccount().remote.getAIRecommendation(type, options);
    }
    async exportData() {
        const { repository } = this.requireAccount();
        const data = await repository.sync.readAll();
        repository.context.assertCurrent();
        return data;
    }
    async exportBackup() { return createBackup(await this.exportData()); }
    async importData(input: unknown, mode: BackupMode) {
        const { repository, reads, coordinator } = this.requireAccount();
        return importAccountBackup(repository, reads, coordinator, input, mode);
    }
}
export const storage = new StorageService({});
