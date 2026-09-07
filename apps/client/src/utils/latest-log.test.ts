import { describe, expect, it } from 'vitest';
import type { WorkoutSet } from '../types';
import { getLatestLog } from './latest-log';

const log = (id: string, date: string, extra: Partial<WorkoutSet> = {}): WorkoutSet => ({
    id, date, workoutTypeId: 'type', workoutId: 'w', updatedAt: date, ...extra,
});
describe('latest log', () => {
    it('uses event date rather than ID, array order or updatedAt without reordering input', () => {
        const newest = log('a', '2026-09-02T00:00:00Z');
        const older = log('z', '2026-09-01T00:00:00Z', { updatedAt: '2026-09-03T00:00:00Z' });
        const logs = [newest, older];
        expect(getLatestLog(logs)).toBe(newest);
        expect(getLatestLog([...logs].reverse())).toBe(newest);
        expect(logs).toEqual([newest, older]);
    });
    it('breaks equivalent timestamp ties by ID independent of arrival order', () => {
        const a = log('a', '2026-09-01T00:00:00Z');
        const z = log('z', '2026-09-01T03:00:00+03:00');
        expect(getLatestLog([a, z])).toBe(z);
        expect(getLatestLog([z, a])).toBe(z);
    });
    it('ignores tombstones and malformed legacy dates, including empty data', () => {
        const valid = log('a', '2026-09-01');
        const invalid = [log('z', '2026-09-02', { isDeleted: true }), log('y', 'broken'), log('x', null as unknown as string)];
        expect(getLatestLog([valid, ...invalid])).toBe(valid);
        expect(getLatestLog(invalid)).toBeUndefined();
        expect(getLatestLog([])).toBeUndefined();
    });
});
