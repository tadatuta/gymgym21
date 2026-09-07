import type { WorkoutSet } from '../types';

/** Event time defines latest; ID breaks ties consistently across storage orders. */
export function getLatestLog(logs: readonly WorkoutSet[]): WorkoutSet | undefined {
    let latest: WorkoutSet | undefined;
    let latestTime = -Infinity;
    for (const log of logs) {
        const time = typeof log.date === 'string' ? Date.parse(log.date) : NaN;
        if (log.isDeleted || !Number.isFinite(time)) continue;
        if (time > latestTime || (time === latestTime && latest && log.id > latest.id)) {
            latest = log;
            latestTime = time;
        }
    }
    return latest;
}
