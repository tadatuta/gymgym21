import { describe, expect, it } from 'vitest';
import {
    escapeAttribute,
    escapeHtml,
    renderOption,
    replaceAvatarContent,
    sanitizeUrl,
} from './safe-html';

describe('safe-html helpers', () => {
    it('renders exercise names in select options as inert text', () => {
        const payload = '<img src=x onerror="alert(1)">';
        const markup = `<select>${renderOption('exercise-id', payload, true)}</select>`;
        const container = document.createElement('div');
        container.innerHTML = markup;

        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('option')?.textContent).toBe(payload);
        expect(container.querySelector('option')?.selected).toBe(true);
    });

    it('renders workout names in headers as inert text', () => {
        const payload = '<svg onload=alert(1)>';

        const markup = `<div class="workout-name">${escapeHtml(payload)}</div>`;
        const container = document.createElement('div');
        container.innerHTML = markup;

        expect(container.querySelector('svg')).toBeNull();
        expect(container.querySelector('.workout-name')?.textContent).toBe(payload);
    });

    it('escapes quotes in attribute values', () => {
        const payload = '"><img src=x onerror=alert(1)></textarea>';

        const markup = `<input value="${escapeAttribute(payload)}">`;
        const container = document.createElement('div');
        container.innerHTML = markup;

        const input = container.querySelector('input');
        expect(container.querySelector('img')).toBeNull();
        expect(input?.getAttribute('value')).toBe(payload);
        expect(markup).toContain('&quot;');
    });

    it('rejects unsafe or malformed avatar urls', () => {
        expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
        expect(sanitizeUrl('http://%zz')).toBeNull();
        expect(sanitizeUrl('//evil.example/avatar.png')).toBeNull();
    });

    it('allows valid https and same-origin relative avatar urls', () => {
        expect(sanitizeUrl('https://example.com/avatar.png')).toBe('https://example.com/avatar.png');
        expect(sanitizeUrl('/images/avatar.png', 'https://gym21.example/app')).toBe('https://gym21.example/images/avatar.png');
    });

    it('renders avatar updates without creating dangerous img tags', () => {
        const container = document.createElement('div');

        replaceAvatarContent(container, 'Athlete', 'javascript:alert(1)');
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toBe('A');

        replaceAvatarContent(container, 'Athlete', 'https://example.com/avatar.png');
        const img = container.querySelector('img');
        expect(img).not.toBeNull();
        expect(img?.getAttribute('src')).toBe('https://example.com/avatar.png');
        expect(img?.getAttribute('alt')).toBe('Athlete');
    });

    it('keeps friend button metadata inert in the DOM', () => {
        const payload = '"><img src=x onerror=alert(1)>';
        const markup = `<button data-name="${escapeAttribute(payload)}">${escapeHtml(payload)}</button>`;
        const container = document.createElement('div');
        container.innerHTML = markup;

        const button = container.querySelector('button');
        expect(container.querySelector('img')).toBeNull();
        expect(button?.getAttribute('data-name')).toBe(payload);
        expect(button?.textContent).toBe(payload);
    });
});
