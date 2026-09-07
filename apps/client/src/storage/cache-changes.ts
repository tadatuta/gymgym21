import type { SyncEntityType } from '../types';
export interface EntityChange { entityType: SyncEntityType; entityId: string; }
export interface CacheChanges { entities: EntityChange[]; conflicts: string[]; }
/** Account-owned commit journal. Taking a batch leaves later commits in a fresh journal. */
export class CacheChangeJournal {
    private entities = new Map<string, EntityChange>();
    private conflicts = new Set<string>();
    add(changes: CacheChanges) {
        for (const item of changes.entities) this.entities.set(`${item.entityType}:${item.entityId}`, item);
        for (const key of changes.conflicts) this.conflicts.add(key);
    }
    take(): CacheChanges {
        const changes = { entities: [...this.entities.values()], conflicts: [...this.conflicts] };
        this.entities.clear(); this.conflicts.clear();
        return changes;
    }
}
