import { dayKey } from './training-time';
import { sessionDurationSeconds } from './duration';
import { WorkoutSet, WorkoutSession } from '../types';

/**
 * Calculates the Estimated One Rep Max (1RM) using the Epley formula.
 * 1RM = Weight * (1 + Reps / 30)
 */
export function calculateOneRepMax(weight: number = 0, reps: number = 0): number {
    if (reps === 1) return weight;
    return Math.round(weight * (1 + reps / 30));
}

/**
 * Aggregates volume by date for a specific workout type or all workouts.
 */
export function getVolumeByDate(logs: WorkoutSet[], workoutTypeId: string | 'all' = 'all', timeZone = 'UTC'): Map<string, number> {
    const volumeMap = new Map<string, number>();

    const filteredLogs = workoutTypeId === 'all'
        ? logs
        : logs.filter(l => l.workoutTypeId === workoutTypeId);

    filteredLogs.forEach(log => {
        const date = dayKey(log.date, timeZone);
        const volume = (log.weight || 0) * (log.reps || 0);
        const currentVolume = volumeMap.get(date) || 0;
        volumeMap.set(date, currentVolume + volume);
    });

    return volumeMap;
}

/**
 * Calculates daily 1RM for a specific exercise to track strength progress.
 * Returns a map of Date -> Max 1RM for that day.
 */
export function getOneRepMaxByDate(logs: WorkoutSet[], workoutTypeId: string, timeZone = 'UTC'): Map<string, number> {
    const maxMap = new Map<string, number>();

    const filteredLogs = logs.filter(l => l.workoutTypeId === workoutTypeId);

    filteredLogs.forEach(log => {
        const date = dayKey(log.date, timeZone);
        const oneRepMax = calculateOneRepMax(log.weight || 0, log.reps || 0);
        const currentMax = maxMap.get(date) || 0;

        if (oneRepMax > currentMax) {
            maxMap.set(date, oneRepMax);
        }
    });

    return maxMap;
}

/**
 * Get distinct days where a workout occurred (for Heatmap).
 */
export function getWorkoutDates(sessions: WorkoutSession[], logs: WorkoutSet[], timeZone = 'UTC'): Set<string> {
    const dates = new Set<string>();

    sessions.forEach(s => dates.add(dayKey(s.startTime, timeZone)));
    logs.forEach(l => dates.add(dayKey(l.date, timeZone)));

    return dates;
}

/**
 * Calculates statistics for workout duration.
 */
export function getDurationStats(sessions: WorkoutSession[], logs: WorkoutSet[] = []) {
    const validSessions = sessions.filter(s => !s.isDeleted && s.endTime && s.status === 'finished');
    const totalSeconds = validSessions.reduce((sum, s) => sum + sessionDurationSeconds(s, logs), 0);
    const averageSeconds = validSessions.length ? totalSeconds / validSessions.length : 0;
    return { totalSeconds, averageSeconds, totalMinutes: totalSeconds / 60, averageMinutes: averageSeconds / 60, count: validSessions.length };
}
