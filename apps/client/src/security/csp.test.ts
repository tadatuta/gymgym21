import { describe, expect, it } from 'vitest';
import { connectSources } from '../../config/csp';

describe('CSP connection origins', () => {
    it('allows same-origin defaults and exact configured API origins, never schemes or wildcard ports', () => {
        expect(connectSources({})).toBe("'self' https://mc.yandex.ru https://mc.yandex.com");
        expect(connectSources({ VITE_AUTH_BASE_URL: 'http://localhost:8788/api/auth', VITE_API_BASE_URL: 'https://api.example.test/path?x=%22' }))
            .toBe("'self' https://mc.yandex.ru https://mc.yandex.com http://localhost:8788 https://api.example.test");
        expect(connectSources({ VITE_API_BASE_URL: '//api.example.test/api' })).toContain('https://api.example.test http://api.example.test');
        expect(connectSources({ VITE_API_BASE_URL: '/api' })).toBe(connectSources({}));
    });
    it('adds exact websocket origins only for the running development server', () => {
        expect(connectSources({}, ['http://127.0.0.1:5173/'])).toContain('ws://127.0.0.1:5173');
        expect(connectSources({})).not.toContain('ws:');
    });
});
