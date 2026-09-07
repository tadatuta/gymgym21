import type { SyncItem } from '../types';

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
}

/** Only transport bookkeeping is omitted; identity, tombstones and all domain fields remain. */
export function recordDomainSnapshot(item: SyncItem | undefined): string | undefined {
    return item && JSON.stringify(canonical(Object.fromEntries(Object.entries(item)
        .filter(([key]) => !['version', 'serverUpdatedAt', 'updatedAt'].includes(key)))));
}
