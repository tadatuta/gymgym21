import { describe, expect, it } from 'vitest';
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
