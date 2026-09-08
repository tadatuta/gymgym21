import { afterEach, describe, expect, it } from 'vitest';
import { renderTypeahead } from './Typeahead';

describe('renderTypeahead', () => {
    it('keeps malicious exercise names inert in the rendered markup', () => {
        const payload = '<img src=x onerror=alert(1)>';
        const markup = renderTypeahead({
            items: [{ id: 'type-1', name: payload }],
            selectedId: 'type-1',
            name: 'typeId',
            inputId: 'workout-type-select',
        });

        const container = document.createElement('div');
        container.innerHTML = markup;

        expect(container.querySelector('img')).toBeNull();
        expect((container.querySelector('[data-typeahead-input]') as HTMLInputElement | null)?.value).toBe(payload);
        expect((container.querySelector('[data-typeahead-value]') as HTMLInputElement | null)?.value).toBe('type-1');
    });
});

describe('accessible typeahead interaction', () => {
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    afterEach(() => { HTMLElement.prototype.scrollIntoView = originalScroll; });
    it('connects the label to the visible field and announces keyboard selection without changing submitted IDs', async () => {
        HTMLElement.prototype.scrollIntoView = () => {};
        const { bindTypeahead, registerTypeaheadItems } = await import('./Typeahead');
        const items = [{ id: 'bench', name: 'Жим' }, { id: 'run', name: 'Бег' }];
        document.body.innerHTML = `<form><label for="exercise">Упражнение</label>${renderTypeahead({ items, name: 'typeId', inputId: 'exercise' })}</form>`;
        registerTypeaheadItems(document, items);
        const dispose = bindTypeahead();
        const input = document.getElementById('exercise') as HTMLInputElement;
        expect(document.querySelector('label')?.control).toBe(input);
        expect(input.type).toBe('text');
        expect(input.getAttribute('role')).toBe('combobox');
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input'));
        document.querySelectorAll('.typeahead__option').forEach(option => {
            (option as HTMLElement).scrollIntoView = () => {};
        });
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
        const active = document.getElementById(input.getAttribute('aria-activedescendant') || '');
        expect(active?.textContent).toBe('Бег');
        expect(active?.getAttribute('aria-selected')).toBe('true');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        expect(input.value).toBe('Бег');
        expect(new FormData(document.querySelector('form')!).get('typeId')).toBe('run');
        expect(input.getAttribute('aria-expanded')).toBe('false');
        expect(input.hasAttribute('aria-activedescendant')).toBe(false);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        expect(document.activeElement).toBe(input);
        expect(input.getAttribute('aria-expanded')).toBe('false');
        dispose();
    });
});
