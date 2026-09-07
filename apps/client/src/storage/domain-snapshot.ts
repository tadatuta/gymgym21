import type { AppData, SyncItem } from '../types';

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
}

/** Only transport bookkeeping is omitted; identity, tombstones and all domain fields remain. */
export function domainSnapshot(data: AppData): string {
    const entity = (item: SyncItem) => Object.fromEntries(Object.entries(item)
        .filter(([key]) => !['version', 'serverUpdatedAt', 'updatedAt'].includes(key)));
    return JSON.stringify(canonical({
        workouts: data.workouts.map(entity), logs: data.logs.map(entity),
        workoutTypes: data.workoutTypes.map(entity), profile: data.profile && entity(data.profile),
    }));
}
