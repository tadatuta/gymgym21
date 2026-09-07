import source from './main.ts?raw';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as safeHtml from './utils/safe-html';
import * as typeahead from './components/typeahead/Typeahead';
import { FormDrafts } from './utils/form-drafts';
import { renderProfileStats } from './components/profile/ProfileStats';

// Execute production renderers, bindings and onUpdate without booting auth/SW (S01 removes this seam).
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    || ts.isVariableStatement(node) && !!(node.declarationList.flags & ts.NodeFlags.Let)
    || ts.isExpressionStatement(node) && node.getText(ast).startsWith('storage.onUpdate('));
const compiled = ts.transpileModule(declarations.map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
}).outputText;
const input = (selector: string, value: string) => {
    const field = document.querySelector<HTMLInputElement>(selector)!;
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return field;
};
const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
const submit = async (selector: string) => {
    document.querySelector(selector)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
};
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.innerHTML = ''; vi.restoreAllMocks(); });
function setup(page = 'main', manyTypes = false) {
    document.body.innerHTML = '<div id="app"></div>';
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    let account = 'A';
    let refresh = () => {};
    let active = false;
    const types = Array.from({ length: manyTypes ? 11 : 2 }, (_, i) => ({ id: `t${i}`, name: i === 1 ? 'Running' : `Exercise ${i}`, category: i === 1 ? 'time' : 'strength' }));
    const logs = [{ id: 'l1', workoutTypeId: 't0', workoutId: 'w1', weight: 10, reps: 2, date: new Date().toISOString() }];
    const workouts = [{ id: 'w1', name: 'Session', startTime: new Date().toISOString(), status: 'finished', pauseIntervals: [] }];
    const profile = { displayName: 'Original', isPublic: false, gender: '', additionalInfo: '' };
    const storage = {
        getWorkoutTypes: () => types, getLogs: () => logs, getWorkouts: () => workouts,
        getActiveWorkout: () => active ? { ...workouts[0], status: 'active' } : null, getWorkoutDuration: () => 0, getProfile: () => profile, getProfileIdentifier: () => '',
        getConflicts: () => [], getStorageKey: () => account,
        onUpdate: (fn: () => void) => { refresh = fn; },
        addLog: vi.fn(async (data) => { logs.push({ ...logs[0], ...data, id: 'l2' }); refresh(); return logs.at(-1)!; }),
        updateLog: vi.fn(async (data) => { Object.assign(logs[0], data); refresh(); }),
        addWorkoutType: vi.fn(async (name, category) => { types.push({ id: 'new', name, category }); refresh(); }),
        updateWorkoutType: vi.fn(async (id, name, category) => { Object.assign(types.find(type => type.id === id)!, { name, category }); refresh(); }),
        updateWorkout: vi.fn(async (_id, data) => { Object.assign(workouts[0], data); refresh(); }),
        startWorkout: vi.fn(async () => { active = true; refresh(); }),
        finishWorkout: vi.fn(async () => { active = false; refresh(); }),
        updateProfileSettings: vi.fn(async (data) => { Object.assign(profile, data); refresh(); }),
    };
    const context = {
        ...safeHtml, ...typeahead, FormDrafts, storage, renderProfileStats,
        captureAccountContext: () => ({ storageKey: account }),
        createInternalRoute: (name: string) => ({ name }), getCurrentUser: () => ({ name: 'User' }),
        hasVerifiedOnlineAccount: () => true, canUsePasskeyInCurrentContext: () => false,
        renderHeatmap: () => '', replaceMarkdownContent: () => {},
        Sortable: { create: () => {} }, getProfileLink: () => '', TELEGRAM_BOT_NAME: 'test',
    };
    const ui = new Function(...Object.keys(context), `${compiled}; return {
      route(name) { currentRoute = {name}; render(); },
      tab(name) { currentProfileTab = name; updateProfileTabContent(); },
      dispose() { formDrafts?.dispose(); clearInterval(workoutTimerInterval); clearTimeout(toastTimeout); }
    };`)(...Object.values(context));
    cleanups.push(() => ui.dispose());
    ui.route(page);
    return { storage, profile, types, ui, refresh: () => refresh(), account: (value: string) => { account = value; refresh(); } };
}

describe('production UI drafts across storage updates', () => {
    it('preserves a new log, selected exercise and focused selection across full background renders, then clears successful submit', async () => {
        const app = setup();
        input('[name=weight]', '43');
        input('[name=reps]', '7');
        app.refresh();
        expect(document.querySelector<HTMLInputElement>('[name=weight]')!.value).toBe('43');
        await submit('#log-form');
        expect(app.storage.addLog).toHaveBeenCalledWith(expect.objectContaining({ weight: 43, reps: 7 }));
        expect(document.querySelector<HTMLInputElement>('[name=weight]')!.value).toBe('');
        app.refresh();
        expect(document.querySelector<HTMLInputElement>('[name=weight]')!.value).toBe('');
    });
    it('keeps typeahead query, hidden selected id and time field visibility, with a usable dropdown after refresh', () => {
        const app = setup('main', true);
        const hidden = document.querySelector<HTMLInputElement>('[data-typeahead-value]')!;
        hidden.value = 't1';
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
        const query = input('[data-typeahead-input]', 'Run');
        query.focus(); query.setSelectionRange(1, 2);
        input('[name=duration_minutes]', '15');
        query.focus(); query.setSelectionRange(1, 2);
        app.refresh();
        const restored = document.querySelector<HTMLInputElement>('[data-typeahead-input]')!;
        expect(restored.value).toBe('Run');
        expect(document.activeElement).toBe(restored);
        expect([restored.selectionStart, restored.selectionEnd]).toEqual([1, 2]);
        expect(document.querySelector<HTMLInputElement>('[data-typeahead-value]')!.value).toBe('t1');
        expect(document.querySelector<HTMLElement>('#time-inputs')!.style.display).toBe('block');
        expect(document.querySelector('[data-typeahead-dropdown]')!.textContent).toContain('Running');
        click('[data-typeahead-option-index="0"]');
        expect(restored.value).toBe('Running');
    });
    it('preserves edits, then discards cancelled log and workout drafts', () => {
        const app = setup();
        click('.log-set__edit');
        input('[name=weight]', '77'); app.refresh();
        expect(document.querySelector<HTMLInputElement>('[name=weight]')!.value).toBe('77');
        click('#cancel-edit-btn'); click('.log-set__edit');
        expect(document.querySelector<HTMLInputElement>('[name=weight]')!.value).toBe('10');
        click('.workout-header__edit');
        input('#workout-edit-form [name=workoutName]', 'Draft session'); app.refresh();
        expect(document.querySelector<HTMLInputElement>('#workout-edit-form [name=workoutName]')!.value).toBe('Draft session');
        click('#cancel-edit-workout-btn'); click('.workout-header__edit');
        expect(document.querySelector<HTMLInputElement>('#workout-edit-form [name=workoutName]')!.value).toBe('Session');
    });
    it('keeps type edits and radio values; switching edit target and saving clears the old draft', async () => {
        const app = setup('settings');
        click('.type-item__edit[data-id=t0]'); input('#new-type-name', 'Draft');
        click('[name=new-type-category][value=time]'); app.refresh();
        expect(document.querySelector<HTMLInputElement>('#new-type-name')!.value).toBe('Draft');
        expect(document.querySelector<HTMLInputElement>('[name=new-type-category][value=time]')!.checked).toBe(true);
        click('.type-item__edit[data-id=t1]');
        expect(document.querySelector<HTMLInputElement>('#new-type-name')!.value).toBe('Running');
        click('.type-item__edit[data-id=t0]');
        expect(document.querySelector<HTMLInputElement>('#new-type-name')!.value).toBe('Exercise 0');
        input('#new-type-name', 'Saved'); await submit('#add-type-form'); app.refresh();
        expect(document.querySelector<HTMLInputElement>('#new-type-name')!.value).toBe('');
    });
    it('preserves public/data/AI tab drafts independently and lets remote values appear after save', async () => {
        const app = setup('profile-settings');
        const period = document.querySelector<HTMLSelectElement>('#ai-plan-period')!;
        period.selectedIndex = 1; period.dispatchEvent(new Event('change', { bubbles: true }));
        const selected = period.value;
        app.ui.tab('public');
        input('#profile-display-name', 'Draft name'); click('#profile-public-toggle');
        app.refresh();
        expect(document.querySelector<HTMLInputElement>('#profile-display-name')!.value).toBe('Draft name');
        expect(document.querySelector<HTMLInputElement>('#profile-public-toggle')!.checked).toBe(true);
        app.ui.tab('ai'); input('#profile-additional-info', 'My notes'); input('#profile-gender', 'female'); app.refresh();
        expect(document.querySelector<HTMLTextAreaElement>('#profile-additional-info')!.value).toBe('My notes');
        expect(document.querySelector<HTMLSelectElement>('#profile-gender')!.value).toBe('female');
        app.ui.tab('data'); input('#import-mode', 'replace'); app.refresh();
        expect(document.querySelector<HTMLSelectElement>('#import-mode')!.value).toBe('replace');
        app.ui.tab('ai'); expect(document.querySelector<HTMLSelectElement>('#ai-plan-period')!.value).toBe(selected);
        app.ui.tab('public'); click('#save-profile-btn'); await new Promise(resolve => setTimeout(resolve, 0));
        app.profile.displayName = 'Remote'; app.refresh();
        expect(document.querySelector<HTMLInputElement>('#profile-display-name')!.value).toBe('Remote');
        app.ui.tab('ai'); expect(document.querySelector<HTMLTextAreaElement>('#profile-additional-info')!.value).toBe('My notes');
        click('#save-profile-btn'); await new Promise(resolve => setTimeout(resolve, 0));
        expect(document.querySelector<HTMLSelectElement>('#ai-plan-period')!.value).toBe(selected);
        app.profile.additionalInfo = 'Remote notes'; app.refresh();
        expect(document.querySelector<HTMLTextAreaElement>('#profile-additional-info')!.value).toBe('Remote notes');
    });
    it('preserves drafts across routes, and restores focus even before the first edit', () => {
        const app = setup('settings');
        const pristine = document.querySelector<HTMLInputElement>('#new-type-name')!;
        pristine.focus(); app.refresh();
        expect(document.activeElement).toBe(document.querySelector('#new-type-name'));
        input('#new-type-name', 'Pending type');
        app.ui.route('main'); input('[name=weight]', '33');
        app.ui.route('settings'); expect(document.querySelector<HTMLInputElement>('#new-type-name')!.value).toBe('Pending type');
        app.ui.route('main'); expect(document.querySelector<HTMLInputElement>('[name=weight]')!.value).toBe('33');
    });
    it('clears successful log and workout edit drafts before reopening the same entity', async () => {
        const app = setup();
        click('.log-set__edit'); input('[name=weight]', '66'); await submit('#log-form');
        click('.log-set__edit'); expect(document.querySelector<HTMLInputElement>('[name=weight]')!.value).toBe('66');
        click('#cancel-edit-btn');
        click('.workout-header__edit'); input('#workout-edit-form [name=workoutName]', 'Saved session'); await submit('#workout-edit-form');
        expect(document.querySelector('#workout-edit-form')).toBeNull();
        click('.workout-header__edit');
        expect(document.querySelector<HTMLInputElement>('#workout-edit-form [name=workoutName]')!.value).toBe('Saved session');
        expect(app.storage.updateWorkout).toHaveBeenCalledTimes(1);
    });
    it('isolates accounts even with identical route and entity ids', () => {
        const app = setup('settings');
        input('#new-type-name', 'Private A'); app.account('B');
        expect(document.querySelector<HTMLInputElement>('#new-type-name')!.value).toBe('');
        app.account('A'); expect(document.querySelector<HTMLInputElement>('#new-type-name')!.value).toBe('');
    });
    it('preserves a workout-start draft, clears cancel and does not reopen start after successful start→finish', async () => {
        const app = setup();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        click('#start-workout-btn'); input('[name=workoutName]', 'Draft start'); app.refresh();
        expect(document.querySelector<HTMLInputElement>('[name=workoutName]')!.value).toBe('Draft start');
        click('#cancel-start-workout-btn'); click('#start-workout-btn');
        expect(document.querySelector<HTMLInputElement>('[name=workoutName]')!.value).toBe('');
        input('[name=workoutName]', 'Saved start'); await submit('#start-workout-form');
        click('#finish-workout-btn'); await new Promise(resolve => setTimeout(resolve, 0)); app.refresh();
        expect(document.querySelector('#start-workout-form')).toBeNull();
        expect(document.querySelector('#start-workout-btn')).not.toBeNull();
    });
    it('does not clear newer input typed while a save awaits', async () => {
        const app = setup('settings');
        let finish!: () => void;
        app.storage.addWorkoutType.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        input('#new-type-name', 'Submitted');
        await submit('#add-type-form');
        input('#new-type-name', 'Newer draft'); app.refresh(); finish();
        await new Promise(resolve => setTimeout(resolve, 0)); app.refresh();
        expect(document.querySelector<HTMLInputElement>('#new-type-name')!.value).toBe('Newer draft');
    });
});
