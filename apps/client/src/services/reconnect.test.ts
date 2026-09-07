import { describe, expect, it } from 'vitest';
import { createReconnectCoordinator } from './reconnect';
import type { AuthSession, MigrationStatus, SessionRestoreState } from '../auth';

function harness() {
    const events = new EventTarget();
    const session = { user: { id: 'B' } } as AuthSession;
    let response: SessionRestoreState = { status: 'unavailable' };
    let active = 'A';
    let verifiedKey = 'B';
    let verifiedUser = 'B';
    let valid = true;
    let gate = Promise.resolve();
    const sent: string[] = [];
    const local = new Map([['A', ['offline-set']], ['B', ['B-set']]]);
    const calls: string[] = [];
    const coordinator = createReconnectCoordinator({
        events,
        restore: async () => { calls.push('restore'); await gate; return response; },
        verify: async () => { calls.push('verify'); return { storageKey: verifiedKey, user: { id: verifiedUser } } as MigrationStatus; },
        captureGuard: () => () => valid,
        isSessionCurrent: () => valid,
        activate: async (_session, status) => { calls.push('activate'); active = status.storageKey!; },
        sync: async () => { calls.push('sync'); sent.push(...local.get(active)!); },
        onUnavailable: () => { calls.push('unavailable'); },
        onUnauthenticated: () => { calls.push('login'); },
        onIncomplete: () => { calls.push('incomplete'); },
    });
    return { events, coordinator, calls, local, sent,
        verifyAs: (key: string, user = 'B') => { verifiedKey = key; verifiedUser = user; },
        authenticate: () => { response = { status: 'authenticated', session }; },
        logout: () => { response = { status: 'unauthenticated' }; },
        invalidate: () => { valid = false; },
        block: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; },
    };
}

describe('account reconnect', () => {
    it('retries unavailable bootstrap on online, singleflights manual retry and selects cookie account before sync', async () => {
        const h = harness();
        await h.coordinator.retry();
        expect(h.calls).toEqual(['restore', 'unavailable']);
        h.authenticate();
        const release = h.block();
        h.events.dispatchEvent(new Event('online'));
        const a = h.coordinator.retry();
        expect(h.coordinator.retry()).toBe(a);
        release();
        await a;
        expect(h.calls).toEqual(['restore', 'unavailable', 'restore', 'verify', 'activate', 'sync']);
        expect(h.sent).toEqual(['B-set']);
        expect(h.local.get('A')).toEqual(['offline-set']);
        h.coordinator.dispose();
    });
    it('sends locally saved offline changes after reconnect without reloading', async () => {
        const h = harness();
        await h.coordinator.retry();
        h.local.get('A')!.push('new-offline-set');
        h.authenticate();
        h.verifyAs('A');
        h.events.dispatchEvent(new Event('online'));
        await h.coordinator.retry();
        expect(h.sent).toEqual(['offline-set', 'new-offline-set']);
        h.coordinator.dispose();
    });
    it('rejects a cookie account change between restore and migration status', async () => {
        const h = harness();
        h.authenticate();
        h.verifyAs('C', 'C');
        await h.coordinator.retry();
        expect(h.calls).toEqual(['restore', 'verify', 'unavailable']);
        expect(h.sent).toEqual([]);
        h.coordinator.dispose();
    });
    it('distinguishes no session from server unavailable without deleting local data', async () => {
        const h = harness();
        h.logout();
        await h.coordinator.retry();
        expect(h.calls).toEqual(['restore', 'login']);
        expect(h.local.get('A')).toEqual(['offline-set']);
        h.coordinator.dispose();
    });
    it('cancels late restore on auth mutation and removes disposed listeners', async () => {
        const h = harness();
        h.authenticate();
        const release = h.block();
        const pending = h.coordinator.retry();
        h.events.dispatchEvent(new Event('gym21-auth-changed'));
        release();
        await pending;
        expect(h.calls).toEqual(['restore']);
        h.coordinator.dispose();
        h.events.dispatchEvent(new Event('online'));
        await h.coordinator.retry();
        expect(h.calls).toEqual(['restore']);
    });
    it('does not activate a stale account after identity verification', async () => {
        const h = harness();
        h.authenticate();
        h.invalidate();
        await h.coordinator.retry();
        expect(h.calls).toEqual(['restore', 'verify']);
        h.coordinator.dispose();
    });
});
