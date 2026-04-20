import { describe, expect, it } from 'vitest';
import { renderProfileStats } from './ProfileStats';

describe('renderProfileStats', () => {
    it('renders favorite exercise as text in public profile stats', () => {
        const payload = '<svg onload=alert(1)>';
        const markup = renderProfileStats({
            totalWorkouts: 12,
            totalVolume: 4200,
            favoriteExercise: payload,
            lastWorkoutDate: '2026-04-20T12:00:00.000Z',
        });

        const container = document.createElement('div');
        container.innerHTML = markup;

        expect(container.querySelector('svg')).toBeNull();
        expect(container.textContent).toContain(payload);
    });
});
