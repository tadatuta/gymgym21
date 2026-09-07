import { describe, expect, it } from 'vitest';
import { dayKey, datetimeValue, parseDatetimeValue } from './training-time';
import { sessionDurationSeconds, formatDuration } from './duration';
import { getDurationStats, getVolumeByDate, getOneRepMaxByDate } from './statistics';
import { getTrainingActivity } from './training-activity';
import { renderDurationChart } from '../components/stats/Charts';
import type { WorkoutSession, WorkoutSet } from '../types';

describe('account calendar and one duration model', () => {
    it('uses owner midnight, offsets and DST rather than UTC or viewer days', () => {
        const date = '2026-01-01T21:30:00Z';
        expect(dayKey(date, 'Europe/Moscow')).toBe('2026-01-02');
        expect(dayKey(date, 'America/Los_Angeles')).toBe('2026-01-01');
        expect(dayKey('2026-03-29T22:30:00Z', 'Europe/Berlin')).toBe('2026-03-30');
        const logs = [{ id: 'l', date, workoutId: 'w', workoutTypeId: 't', weight: 10, reps: 1, updatedAt: date }];
        expect([...getTrainingActivity(logs, 'Europe/Moscow').keys()]).toEqual(['2026-01-02']);
        expect([...getVolumeByDate(logs, 'all', 'Europe/Moscow').keys()]).toEqual(['2026-01-02']);
        expect([...getOneRepMaxByDate(logs, 't', 'Europe/Moscow').keys()]).toEqual(['2026-01-02']);
    });
    it('roundtrips account wall time with seconds; rejects gaps and newly ambiguous times', () => {
        const instant = '2026-01-01T21:30:45.123Z';
        expect(datetimeValue(instant, 'Europe/Moscow')).toBe('2026-01-02T00:30');
        expect(parseDatetimeValue('2026-01-02T00:31', 'Europe/Moscow', instant)).toBe('2026-01-01T21:31:45.123Z');
        expect(() => parseDatetimeValue('2026-03-29T02:30', 'Europe/Berlin')).toThrow('Такого времени нет');
        expect(() => parseDatetimeValue('2026-10-25T02:30', 'Europe/Berlin')).toThrow('повторяется');
        for (const original of ['2026-10-25T00:30:11Z', '2026-10-25T01:30:22Z']) {
            expect(parseDatetimeValue('2026-10-25T02:30', 'Europe/Berlin', original)).toBe(original);
        }
    });
    it('cards, chart and average retain seconds and exclude clipped overlapping pauses once', () => {
        const base: WorkoutSession = { id: 'w', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:02:00Z', status: 'finished', isManual: false, updatedAt: '', pauseIntervals: [
            { start: '2025-12-31T23:59:00Z', end: '2026-01-01T00:00:30Z' },
            { start: '2026-01-01T00:00:15Z', end: '2026-01-01T00:01:00Z' },
            { start: '2026-01-01T00:01:30Z', end: '2026-01-01T02:00:00Z' },
        ] };
        const sessions = [base, { ...base, id: 'x' }];
        const logs: WorkoutSet[] = sessions.map(s => ({ id: s.id, workoutId: s.id, workoutTypeId: 't', date: s.startTime, updatedAt: '', durationSeconds: 45 }));
        expect(sessionDurationSeconds(base)).toBe(30);
        expect(sessionDurationSeconds(base, logs)).toBe(45);
        expect(getDurationStats(sessions, logs).averageSeconds).toBe(45);
        expect(renderDurationChart(sessions, logs)).toContain(formatDuration(45));
        expect(sessionDurationSeconds({ ...base, startTime: 'invalid', endTime: 'invalid' }, logs)).toBe(45);
        expect(sessionDurationSeconds({ ...base, endTime: base.startTime }, [])).toBe(0);
        expect(sessionDurationSeconds({ ...base, endTime: undefined, pauseIntervals: [{ start: base.startTime }] }, [], Date.parse(base.startTime) + 30000)).toBe(0);
    });
});
