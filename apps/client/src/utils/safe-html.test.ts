import { describe, expect, it } from 'vitest';
import {
    escapeAttribute,
    escapeHtml,
    replaceAvatarContent,
    sanitizeUrl,
} from './safe-html';

describe('safe-html helpers', () => {
    it('escapes profile-controlled HTML text', () => {
        const payload = '<img src=x onerror="alert(1)">';

        const markup = `<div class="name">${escapeHtml(payload)}</div>`;
        const container = document.createElement('div');
        container.innerHTML = markup;

        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('.name')?.textContent).toBe(payload);
    });

    it('escapes quotes in attribute values', () => {
        const payload = '" autofocus onfocus="alert(1)';

        const markup = `<input value="${escapeAttribute(payload)}">`;
        const container = document.createElement('div');
        container.innerHTML = markup;

        const input = container.querySelector('input');
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
