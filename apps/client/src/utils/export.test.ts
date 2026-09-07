import { describe, expect, it } from 'vitest';
import { generateMarkdown } from './export';
import { dayKey, dayLabel } from './training-time';
import type { AppData, WorkoutSet } from '../types';

const date = '2026-01-01T21:30:00Z';
const set = (id: string, extra: Partial<WorkoutSet> = {}): WorkoutSet => ({ id, workoutId: 'w', workoutTypeId: 't', date, updatedAt: date, weight: 10, reps: Number(id), ...extra });
const data = (logs: WorkoutSet[]): AppData => ({ logs, workouts: [{ id: 'w', name: 'Session', status: 'finished', isManual: true, startTime: date, updatedAt: date, pauseIntervals: [] }, { id: 'deleted', name: 'Old session', isDeleted: true, status: 'finished', isManual: false, startTime: date, updatedAt: date, pauseIntervals: [] }], workoutTypes: [{ id: 't', name: 'Squat', updatedAt: date }, { id: 'deleted', name: 'Old exercise', isDeleted: true, updatedAt: date }], profile: { id: 'me', isPublic: false, createdAt: date, updatedAt: date, timeZone: 'Europe/Moscow' } });

describe('Markdown history export', () => {
    it('preserves every active set exactly once across missing, empty, dangling and deleted references', () => {
        const logs = [set('1'), set('2', { workoutId: '' }), set('3', { workoutId: undefined as unknown as string }), set('4', { workoutId: 'missing', workoutTypeId: 'missing' }), set('5', { workoutId: 'deleted', workoutTypeId: 'deleted' }), set('6', { isDeleted: true })];
        const input = data(logs);
        const before = JSON.stringify(input);
        const markdown = generateMarkdown(input);
        expect(markdown.match(/10кг × \d/g)).toHaveLength(logs.filter(l => !l.isDeleted).length);
        for (let i = 1; i <= 5; i++) expect(markdown.split(`10кг × ${i}`)).toHaveLength(2);
        expect(markdown).not.toContain('10кг × 6');
        expect(markdown).toContain('#### Без тренировки');
        expect(markdown).toContain('Неизвестное упражнение');
        expect(markdown).toContain('Old session');
        expect(markdown).toContain('Old exercise');
        expect(JSON.stringify(input)).toBe(before);
    });
    it.each([{ logs: [] }, { logs: [set('1', { isDeleted: true })] }])('renders empty active history', ({ logs }) => {
        expect(generateMarkdown(data(logs))).toContain('_История пуста_');
    });
    it('exports seconds-only, zero and mixed durations', () => {
        const markdown = generateMarkdown(data([set('1', { durationSeconds: 30 }), set('2', { durationSeconds: 0 }), set('3', { duration: 1, durationSeconds: 45 })]));
        expect(markdown).toContain('0 мин 30 сек, 0 мин, 1 мин 45 сек');
        expect(markdown).not.toContain('10кг');
    });
    it('uses the owner date for history and registration, with browser fallback for legacy profiles', () => {
        const input = data([set('1')]);
        const label = dayLabel('2026-01-02', { year: 'numeric', month: '2-digit', day: '2-digit' });
        expect(generateMarkdown(input)).toContain(`### ${label}`);
        expect(generateMarkdown(input)).toContain(`**Дата регистрации:** ${label}`);
        input.profile!.timeZone = undefined;
        const legacy = dayLabel(dayKey(date, Intl.DateTimeFormat().resolvedOptions().timeZone), { year: 'numeric', month: '2-digit', day: '2-digit' });
        expect(generateMarkdown(input)).toContain(`### ${legacy}`);
    });
});
