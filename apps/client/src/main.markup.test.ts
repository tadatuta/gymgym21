import { describe, expect, it } from 'vitest';
import { renderProfileStats } from './components/profile/ProfileStats';
import { render1RMChart } from './components/stats/Charts';
import { createApplication } from './ui/application';
import type { UiDependencies } from './ui/dependencies';
import * as trainingTime from './utils/training-time';

function historyRenderer(timeZone = 'UTC') {
    return createApplication({ storage: { getTimeZone: () => timeZone, getWorkouts: () => [] } } as unknown as Partial<UiDependencies>).pages.workout.generateLogsListHtml;
}
const hostile = '"><img src=x data-injected=true><svg onload=alert(1)>';
function parse(markup: string) {
    const container = document.createElement('div');
    container.innerHTML = markup;
    expect(container.querySelector('[data-injected], [onload], [onerror]')).toBeNull();
    return container;
}

describe('old persisted records remain text at HTML boundaries', () => {
    it('public history uses the owner zone even when the viewer zone is different', () => {
        const render = historyRenderer('America/Los_Angeles');
        const date = '2026-01-01T21:30:00Z';
        const html = render([{ id: 'l', workoutId: '', workoutTypeId: 't', date, updatedAt: date }], [], false, 'Europe/Moscow');
        expect(html).toContain(trainingTime.dayLabel('2026-01-02'));
        expect(html).not.toContain(trainingTime.dayLabel('2026-01-01'));
    });

    it('escapes log numeric fields and IDs for assigned and orphan sets', () => {
        const render = historyRenderer();
        for (const workoutId of ['', 'missing-workout']) for (const fields of [
            { weight: hostile as unknown as number, reps: hostile as unknown as number }, { duration: hostile as unknown as number, durationSeconds: hostile as unknown as number },
        ]) {
            const container = parse(render([{ id: hostile, workoutTypeId: hostile, workoutId, date: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...fields }], [{ id: hostile, name: hostile, updatedAt: '2026-09-01T00:00:00Z' }], true));
            expect(container.textContent).toContain(hostile);
            expect(container.querySelector('.log-set')?.getAttribute('data-id')).toBe(hostile);
        }
    });
    it('escapes input attributes and the repeat-last-set button from malformed numeric records', () => {
        const log = { id: 'old', workoutTypeId: 'type', date: '2026-09-01T00:00:00Z', weight: hostile as unknown as number, reps: hostile as unknown as number, durationSeconds: hostile };
        for (const editingLogId of ['old', null]) {
            const ui = createApplication({ storage: {
                getWorkoutTypes: () => [{ id: 'type', name: hostile }], getLogs: () => [log],
                getWorkouts: () => [], getActiveWorkout: () => null, getTimeZone: () => 'UTC',
            } } as unknown as Partial<UiDependencies>);
            ui.state.editingLogId = editingLogId;
            const render = ui.pages.workout.render;
            const container = parse(render());
            if (editingLogId) expect(container.querySelector('[name=weight]')?.getAttribute('value')).toBe(hostile);
            else expect(container.querySelector('#duplicate-last-btn')?.textContent).toContain(hostile);
        }
    });
    it('escapes numeric values in profile statistics and SVG titles', () => {
        const value = hostile as unknown as number;
        expect(parse(renderProfileStats({ totalWorkouts: value, totalVolume: 1 })).textContent).toContain(hostile);
        expect(parse(render1RMChart(new Map([['2026-09-01', value], ['2026-09-02', 1]]))).textContent).toContain(hostile);
    });
});
