import type { SyncEntityType } from './types.js';

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    }
    return value;
}

function content(type: SyncEntityType, input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const item = { ...input } as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id) return undefined;
    for (const field of ['version', 'serverUpdatedAt', 'updatedAt']) delete item[field];
    const defaults: Record<string, unknown> = { isDeleted: false };
    if (type === 'workouts') Object.assign(defaults, { isManual: false, pauseIntervals: [] });
    if (type === 'profile') Object.assign(defaults, { isPublic: false, showFullHistory: false, friends: [] });
    if (type === 'logs') Object.assign(defaults, { duration: 0, durationSeconds: 0 });
    for (const [field, value] of Object.entries(defaults)) if (item[field] === undefined) item[field] = value;

    // Keep the measurement fields separate: no arithmetic rounding can hide a change.
    const instant = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
        ? new Date(value).toISOString() : value;
    const dates = type === 'logs' ? ['date'] : type === 'workouts' ? ['startTime', 'endTime'] : type === 'profile' ? ['createdAt'] : [];
    for (const field of dates) if (item[field] !== undefined) item[field] = instant(item[field]);
    if (type === 'workouts' && Array.isArray(item.pauseIntervals)) {
        item.pauseIntervals = item.pauseIntervals.map(interval => interval && typeof interval === 'object'
            ? { ...interval, start: instant(interval.start), end: instant(interval.end) } : interval);
    }
    if (type === 'profile' && Array.isArray(item.friends)) {
        item.friends = item.friends.map(friend => friend && typeof friend === 'object'
            ? { ...friend, addedAt: instant(friend.addedAt) } : friend);
    }
    return JSON.stringify(canonical(item));
}

/** Compare domain content, retaining identity, deletion, privacy and unknown fields. */
export function syncEntityContentEqual(type: SyncEntityType, left: unknown, right: unknown): boolean {
    const a = content(type, left);
    return a !== undefined && a === content(type, right);
}
