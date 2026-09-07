import { hasVerifiedOnlineAccount } from '../auth';
import { SyncError, retryDelay } from '../services/sync-error';
import type { SyncExecutionResult } from '../services/sync';
import type { AccountRepository } from './account-repository';
import type { AccountReads } from './account-reads';
import { ensureProfileTimeZoneAfterBootstrap, ensureDefaultWorkoutTypesAfterBootstrap } from './bootstrap';
export type SyncStatus = 'idle' | 'saving' | 'success' | 'error';

export class SyncCoordinator {
    status: SyncStatus = 'idle';
    private syncTimer: ReturnType<typeof setTimeout> | undefined;
    syncInFlight = false;
    private syncTask?: Promise<SyncExecutionResult | undefined>;
    private syncController?: AbortController;
    private successTimer?: ReturnType<typeof setTimeout>;
    private retryAttempt = 0;
    retryAt = 0;
    private syncFailure?: SyncError;
    syncQueued = false;
    private broadcastChannel?: BroadcastChannel;
    private readonly activeStorageKey;
    private disposed = false;
    private readonly handleVisibilityChange = () => {
        if (document.visibilityState === 'visible' && this.isActive()) {
            this.scheduleSync(0);
            if (this.isActive()) void this.refresh();
        }
    };

    constructor(private readonly repository: AccountRepository, private readonly reads: AccountReads,
        private readonly notifyStatus: (status: SyncStatus) => void,
        private readonly syncDebounceMs: number, private readonly enableBroadcast: boolean) {
        this.activeStorageKey = repository.context.storageKey;
        this.attachSyncTriggers();
        if (this.activeStorageKey) this.connectBroadcastChannel(this.activeStorageKey);
    }
    isActive() { return !this.disposed && this.repository.context.isCurrent(); }
    getSyncState() { return { pendingCount: this.reads.pendingCount, error: this.syncFailure, retryAt: this.retryAt }; }
    dispose() {
        this.disposed = true;
        this.clearScheduledSync();
        this.resetSyncRecovery();
        this.disconnectBroadcastChannel();
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

    private resetSyncRecovery() {
        clearTimeout(this.successTimer);
        this.successTimer = undefined;
        this.syncController?.abort();
        this.syncController = undefined;
        this.syncTask = undefined;
        this.retryAttempt = 0;
        this.retryAt = 0;
        this.syncFailure = undefined;
        this.reads.pendingCount = 0;
    }

    private setStatus(status: SyncStatus) {
        if (!this.isActive()) return;
        this.status = status;
        this.notifyStatus(status);
        if (!this.isActive()) return;

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

    private async refresh() {
        try { await this.reads.reload(); }
        catch (error) { if (this.isActive()) console.warn('Local cache refresh failed', error); }
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
            if (this.isActive()) void this.refresh();
        });
    }

    private disconnectBroadcastChannel() {
        this.broadcastChannel?.close();
        this.broadcastChannel = undefined;
    }

    broadcastUpdate() {
        if (!this.isActive()) return;
        this.broadcastChannel?.postMessage({ type: 'local-data-updated' });
    }

    clearScheduledSync() {
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

    async sync(): Promise<SyncExecutionResult | undefined> {
        if (this.syncTask) {
            this.syncQueued = true;
            return this.syncTask;
        }
        const task = this.performSync();
        this.syncTask = task;
        try { return await task; }
        finally { if (this.syncTask === task) this.syncTask = undefined; }
    }

    private async performSync(): Promise<SyncExecutionResult | undefined> {
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

        const context = this.repository.context;
        this.syncInFlight = true;
        const controller = new AbortController();
        this.syncController = controller;
        let nextDelay = 0;
        let completed: SyncExecutionResult | undefined;
        try {
            const lockAcquired = await this.withSyncLock(async () => {
                context.assertCurrent();
                this.setStatus('saving');
                const result = await this.repository.sync.sync(controller.signal);
                if (controller.signal.aborted) return;
                this.retryAttempt = 0;
                this.retryAt = 0;
                this.syncFailure = undefined;
                context.assertCurrent();
                await this.reads.reload();
                context.assertCurrent();
                if (!result.hasMore && await ensureProfileTimeZoneAfterBootstrap(this.repository, this.reads)) this.syncQueued = true;
                context.assertCurrent();
                const seededDefaults = result.hasMore
                    ? false
                    : await ensureDefaultWorkoutTypesAfterBootstrap(this.repository, this.reads);
                context.assertCurrent();
                completed = result;
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
            if (['INVALID_LOCAL_RECORD', 'RECORD_TOO_LARGE'].includes(this.syncFailure.code)) {
                // The bounded empty push may have successfully pulled remote changes.
                await this.reads.reload();
                if (!context.isCurrent() || controller.signal.aborted) return;
                this.broadcastUpdate();
            }
            this.syncQueued = false;
            if (this.syncFailure.retryable && navigator.onLine) {
                nextDelay = Math.max(retryDelay(this.retryAttempt++), this.syncFailure.retryAfterMs);
                this.retryAt = Date.now() + nextDelay;
                this.syncQueued = true;
            }
            console.warn('Sync interrupted', { code: this.syncFailure.code, retryAt: this.retryAt, pendingCount: this.reads.pendingCount });
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
        return completed;
    }

    async withSyncLock(operation: () => Promise<void>): Promise<boolean> {
        this.repository.context.assertCurrent();
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
                    this.repository.context.assertCurrent();
                    await operation();
                    return true;
                }
                return false;
            },
        );
    }
}
