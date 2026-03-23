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
export function getVolumeByDate(logs: WorkoutSet[], workoutTypeId: string | 'all' = 'all'): Map<string, number> {
    const volumeMap = new Map<string, number>();

    const filteredLogs = workoutTypeId === 'all'
        ? logs
        : logs.filter(l => l.workoutTypeId === workoutTypeId);

    filteredLogs.forEach(log => {
        const date = log.date.split('T')[0];
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
export function getOneRepMaxByDate(logs: WorkoutSet[], workoutTypeId: string): Map<string, number> {
    const maxMap = new Map<string, number>();

    const filteredLogs = logs.filter(l => l.workoutTypeId === workoutTypeId);

    filteredLogs.forEach(log => {
        const date = log.date.split('T')[0];
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
export function getWorkoutDates(sessions: WorkoutSession[], logs: WorkoutSet[]): Set<string> {
    const dates = new Set<string>();

    sessions.forEach(s => dates.add(s.startTime.split('T')[0]));
    logs.forEach(l => dates.add(l.date.split('T')[0]));

    return dates;
}

/**
 * Calculates statistics for workout duration.
 */
export function getDurationStats(sessions: WorkoutSession[]): {
    averageMinutes: number;
    totalMinutes: number;
    count: number;
} {
    const validSessions = sessions.filter(s => s.endTime && s.status === 'finished');

    if (validSessions.length === 0) {
        return { averageMinutes: 0, totalMinutes: 0, count: 0 };
    }

    let totalDurationMs = 0;

    validSessions.forEach(s => {
        const start = new Date(s.startTime).getTime();
        const end = new Date(s.endTime!).getTime();
        let duration = end - start;

        // Subtract pause intervals
        if (s.pauseIntervals) {
            s.pauseIntervals.forEach(interval => {
                const pStart = new Date(interval.start).getTime();
                const pEnd = interval.end ? new Date(interval.end).getTime() : end;
                duration -= (pEnd - pStart);
            });
        }

        totalDurationMs += duration;
    });

    const totalMinutes = Math.round(totalDurationMs / 1000 / 60);
    const averageMinutes = Math.round(totalMinutes / validSessions.length);

    return {
        averageMinutes,
        totalMinutes,
        count: validSessions.length
    };
}
