import { describe, expect, it } from 'vitest';
import { replaceMarkdownContent } from './safe-markdown';

describe('safe markdown rendering', () => {
    it('removes script payloads from AI markdown output', () => {
        const container = document.createElement('div');

        replaceMarkdownContent(container, 'Safe text<script>alert(1)</script>');

        expect(container.querySelector('script')).toBeNull();
        expect(container.textContent).toContain('Safe text');
    });

    it('strips dangerous html tags and event handlers', () => {
        const container = document.createElement('div');

        replaceMarkdownContent(container, '<img src=x onerror=alert(1)>Hello');

        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toContain('Hello');
    });

    it('removes javascript links while keeping readable text', () => {
        const container = document.createElement('div');

        replaceMarkdownContent(container, '[Click me](javascript:alert(1))');

        const link = container.querySelector('a');
        expect(link).not.toBeNull();
        expect(link?.hasAttribute('href')).toBe(false);
        expect(link?.textContent).toBe('Click me');
    });

    it('preserves readable markdown formatting for paragraphs and lists', () => {
        const container = document.createElement('div');

        replaceMarkdownContent(container, '# Plan\n\nStay **consistent**.\n\n- Squat\n- Row');

        expect(container.querySelector('h1')?.textContent).toBe('Plan');
        expect(container.querySelector('strong')?.textContent).toBe('consistent');
        expect(container.querySelectorAll('li')).toHaveLength(2);
    });
});
