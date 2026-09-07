import { describe, expect, it } from 'vitest';
import { renderVolumeChart } from './Charts';
import type { WorkoutSet } from '../../types';
const logs = (weights: number[]): WorkoutSet[] => weights.map((weight, i) => ({ id: String(i), workoutId: 'w', workoutTypeId: 't', date: `2026-01-0${i + 1}T12:00:00Z`, weight, reps: 2, updatedAt: '' }));
describe('volume chart scale', () => {
    it.each([[0, 0], [0, 10], [10, 10], [Infinity, NaN], [Number.MAX_VALUE, Number.MAX_VALUE]])('renders finite SVG dimensions for %j', (...weights) => {
        const html = renderVolumeChart(logs(weights));
        expect(html).toContain('<svg');
        expect(html).not.toMatch(/NaN|Infinity/);
        for (const match of html.matchAll(/(?:y|height)="([\d.]+)%"/g)) {
            expect(Number(match[1])).toBeGreaterThanOrEqual(0);
            expect(Number(match[1])).toBeLessThanOrEqual(100);
        }
    });
    it('keeps zero bars at baseline and positive bars visible', () => {
        const html = renderVolumeChart(logs([0, 10]));
        expect(html).toContain('y="100%"');
        expect(html).toContain('height="0%"');
        expect(html).toContain(': 20кг</title>');
        expect(html).toContain('height="90.9090909090909%"');
    });
    it('renders empty, single-day and tombstone-only history as insufficient data', () => {
        for (const input of [[], logs([0]), logs([0, 1]).map(l => ({ ...l, isDeleted: true }))]) {
            expect(renderVolumeChart(input)).toContain('Недостаточно данных');
        }
    });
});
