import type { Plugin, ResolvedConfig } from 'vite';

// The configured counter uses these collection endpoints. Never allow arbitrary HTTPS.
const analyticsConnections = ['https://mc.yandex.ru', 'https://mc.yandex.com'];

export function connectSources(env: Record<string, string>, developmentOrigins: string[] = []): string {
    const sources = new Set(["'self'", ...analyticsConnections]);
    for (const name of ['VITE_AUTH_BASE_URL', 'VITE_API_BASE_URL']) {
        const value = env[name];
        if (!value) continue;
        // Relative API URLs already use 'self'. Only a URL origin can enter the policy.
        if (/^https?:\/\//i.test(value)) sources.add(new URL(value).origin);
        else if (value.startsWith('//')) {
            sources.add(new URL(value, 'https://same-origin.invalid').origin);
            sources.add(new URL(value, 'http://same-origin.invalid').origin);
        }
    }
    for (const origin of developmentOrigins) sources.add(new URL(origin).origin.replace(/^http/, 'ws'));
    return [...sources].join(' ');
}

export function contentSecurityPolicy(): Plugin {
    let config: ResolvedConfig;
    return {
        name: 'gym21-content-security-policy',
        configResolved(resolved) { config = resolved; },
        transformIndexHtml(html, context) {
            const developmentOrigins = context.server
                ? [...(context.server.resolvedUrls?.local || []), ...(context.server.resolvedUrls?.network || [])]
                : [];
            return html.replace(/connect-src [^;]+;/, `connect-src ${connectSources(config.env, developmentOrigins)};`);
        },
    };
}
