import type { Table } from 'dexie';
import { captureAccountContext } from '../db';
import { SyncService } from '../services/sync';
import type { SyncEntityType } from '../types';

export interface MutationResult<T> {
    value: T;
    dirty: Array<{ entityType: SyncEntityType; entityId: string }>;
}

/** Immutable ownership boundary: no operation consults the active global database. */
export class AccountRepository {
    private disposed = false;
    private readonly controller = new AbortController();
    readonly context;
    readonly database;
    readonly sync;

    constructor(context = captureAccountContext()) {
        this.context = {
            ...context,
            signal: AbortSignal.any([context.signal, this.controller.signal]),
            isCurrent: () => !this.disposed && context.isCurrent(),
            assertCurrent: () => {
                if (this.disposed) throw new Error('Stale account operation (disposed repository)');
                context.assertCurrent();
            },
        };
        this.database = context.database;
        this.sync = new SyncService(this.context);
    }

    dispose() { this.disposed = true; this.controller.abort(); }

    async transaction<T>(tables: Table[], operation: () => Promise<T>): Promise<T> {
        this.context.assertCurrent();
        const value = await this.database.transaction('rw', tables, async () => {
            this.context.assertCurrent();
            const result = await operation();
            // Throw inside the transaction, rolling back both domain changes and outbox.
            this.context.assertCurrent();
            return result;
        });
        this.context.assertCurrent();
        return value;
    }

    async mutate<T>(tables: Table[], operation: () => Promise<MutationResult<T>>): Promise<T> {
        return this.transaction([...tables, this.database.dirtyEntities], async () => {
            const result = await operation();
            this.context.assertCurrent();
            await this.sync.markDirtyMany(result.dirty);
            this.context.assertCurrent();
            return result.value;
        });
    }
}
