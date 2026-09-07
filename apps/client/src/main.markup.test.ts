import source from './main.ts?raw';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as safeHtml from './utils/safe-html';
import { renderProfileStats } from './components/profile/ProfileStats';
import { render1RMChart } from './components/stats/Charts';

// Execute the actual legacy main.ts renderers without starting auth/service workers.
// This seam can disappear when S01 separates page rendering from application startup.
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
function renderer(name: string, context: Record<string, unknown>): (...args: unknown[]) => string {
    const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing renderer: ${name}`);
    const compiled = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    return new Function(...Object.keys(context), `${compiled}; return ${name};`)(...Object.values(context));
}
const hostile = '"><img src=x data-injected=true><svg onload=alert(1)>';
function parse(markup: string) {
    const container = document.createElement('div');
    container.innerHTML = markup;
    expect(container.querySelector('[data-injected], [onload], [onerror]')).toBeNull();
    return container;
}

describe('old persisted records remain text at HTML boundaries', () => {
    it('escapes log numeric fields and IDs for assigned and orphan sets', () => {
        const render = renderer('generateLogsListHtml', {
            ...safeHtml, storage: { getWorkouts: () => [] }, editingWorkoutId: null, editingLogId: null, lastAddedLogId: null,
        });
        for (const workoutId of ['', 'missing-workout']) for (const fields of [
            { weight: hostile, reps: hostile }, { duration: hostile, durationSeconds: hostile },
        ]) {
            const container = parse(render([{ id: hostile, workoutTypeId: hostile, workoutId, date: '2026-09-01T00:00:00Z', ...fields }], [{ id: hostile, name: hostile }], true));
            expect(container.textContent).toContain(hostile);
            expect(container.querySelector('.log-set')?.getAttribute('data-id')).toBe(hostile);
        }
    });
    it('escapes input attributes and the repeat-last-set button from malformed numeric records', () => {
        const log = { id: 'old', workoutTypeId: 'type', date: '2026-09-01T00:00:00Z', weight: hostile, reps: hostile, durationSeconds: hostile };
        for (const editingLogId of ['old', null]) {
            const render = renderer('renderMainPage', {
                ...safeHtml, storage: { getWorkoutTypes: () => [{ id: 'type', name: hostile }], getLogs: () => [log] },
                editingLogId, currentWeekOffset: 0, getWeekRange: () => ({ label: '' }), renderWorkoutControls: () => '',
                renderLogsList: () => '', lastCalendarValue: '', isFilterEnabled: false, toLocalDatetimeValue: () => '2026-09-01T00:00',
            });
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
