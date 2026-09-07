import type { AuthSession, MigrationStatus, SessionRestoreState } from '../auth';

interface ReconnectOptions {
    events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
    restore(): Promise<SessionRestoreState>;
    verify(): Promise<MigrationStatus>;
    isSessionCurrent(session: AuthSession): boolean;
    captureGuard(): () => boolean;
    activate(session: AuthSession, status: MigrationStatus): Promise<void>;
    sync(): Promise<unknown>;
    onUnavailable(): void;
    onUnauthenticated(): void;
    onIncomplete(): void;
}

/** One path for bootstrap, browser reconnect and explicit retry. */
export function createReconnectCoordinator(options: ReconnectOptions) {
    let disposed = false;
    let generation = 0;
    let pending: Promise<void> | undefined;
    const invalidate = () => { generation += 1; };
    const retry = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        if (pending) return pending;
        const attempt = generation;
        const current = () => !disposed && attempt === generation;
        pending = (async () => {
            try {
                const state = await options.restore();
                if (!current()) return;
                if (state.status === 'unavailable') {
                    options.onUnavailable();
                    return;
                }
                if (state.status === 'unauthenticated') {
                    options.onUnauthenticated();
                    return;
                }
                const session = state.session;
                const guard = options.captureGuard();
                const valid = () => current() && options.isSessionCurrent(session);
                const status = await options.verify();
                if (!valid() || !guard()) return;
                if (status.user.id !== session.user.id) {
                    options.onUnavailable();
                    return;
                }
                if (status.needsCompletion) {
                    options.onIncomplete();
                    return;
                }
                await options.activate(session, status);
                if (!valid()) return;
                await options.sync();
            } catch (error) {
                if (!current()) return;
                console.warn('Account reconnect failed; local changes remain on this device', error);
                options.onUnavailable();
            }
        })().finally(() => { pending = undefined; });
        return pending;
    };
    const online = () => { void retry(); };
    options.events.addEventListener('online', online);
    options.events.addEventListener('gym21-auth-changed', invalidate);
    return {
        retry,
        dispose() {
            disposed = true;
            invalidate();
            options.events.removeEventListener('online', online);
            options.events.removeEventListener('gym21-auth-changed', invalidate);
        },
    };
}
