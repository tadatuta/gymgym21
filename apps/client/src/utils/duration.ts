import type { WorkoutSession, WorkoutSet } from '../types';
const nonnegative = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, value!) : 0;
/** Elapsed time excludes the union of pauses clipped to the session; entered set time is a lower bound. */
export function sessionDurationSeconds(session: WorkoutSession, logs: WorkoutSet[] = [], now = Date.now()): number {
    if (session.isDeleted) return 0;
    const start = Date.parse(session.startTime);
    const end = session.endTime ? Date.parse(session.endTime) : now;
    let elapsed = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    const pauses = (session.pauseIntervals ?? []).map(p => [Math.max(start, Date.parse(p.start)), Math.min(end, p.end ? Date.parse(p.end) : end)])
        .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((a, b) => a[0] - b[0]);
    let coveredUntil = start;
    for (const [a, b] of pauses) {
        elapsed -= Math.max(0, b - Math.max(a, coveredUntil));
        coveredUntil = Math.max(coveredUntil, b);
    }
    const entered = logs.filter(l => !l.isDeleted && l.workoutId === session.id)
        .reduce((sum, l) => sum + nonnegative(l.duration) * 60 + nonnegative(l.durationSeconds), 0);
    return Math.max(0, Math.floor(elapsed / 1000), entered);
}
export function formatDuration(seconds: number): string {
    const total = Math.round(nonnegative(seconds));
    const minutes = Math.floor(total / 60);
    return `${minutes} мин${total % 60 ? ` ${total % 60} сек` : ''}`;
}
