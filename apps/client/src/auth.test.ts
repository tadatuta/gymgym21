import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const signOutMock = vi.hoisted(() => vi.fn());

vi.mock('@better-auth/passkey/client', () => ({
  passkeyClient: () => ({}),
}));

vi.mock('better-auth/client', () => ({
  createAuthClient: () => ({
    getSession: getSessionMock,
    signOut: signOutMock,
    signIn: {
      email: vi.fn(),
      passkey: vi.fn(),
    },
    passkey: {
      addPasskey: vi.fn(),
    },
  }),
}));

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
}

function migrationStatus(storageKey: string) {
  const user = {
    id: 'user-1',
    email: 'user@example.com',
    emailVerified: true,
    name: 'Offline User',
    username: 'offline_user',
    migrationCompleted: true,
  };

  return {
    user,
    storageKey,
    canonicalAlias: 'offline_user',
    suggestedUsername: null,
    hasPassword: true,
    hasPasskey: false,
    hasTelegram: false,
    emailIsPlaceholder: false,
    needsCompletion: false,
    linkedProviders: [],
    telegramUserId: null,
  };
}

describe('offline account identity', () => {
  beforeEach(() => {
    vi.resetModules();
    getSessionMock.mockReset();
    signOutMock.mockReset();
    vi.stubGlobal('localStorage', createMemoryStorage());
  });

  it('persists only a non-secret account descriptor and restores it after reload', async () => {
    const auth = await import('./auth');
    const status = migrationStatus('storage-user-1');
    auth.cacheOfflineAccount(status.user, status);

    const serialized = localStorage.getItem('gym21_offline_accounts_v1') || '';
    expect(serialized).toContain('storage-user-1');
    expect(serialized).not.toContain('"token"');
    expect(serialized).not.toContain('"session"');

    vi.resetModules();
    const reloadedAuth = await import('./auth');
    expect(reloadedAuth.getOfflineAccount()?.storageKey).toBe('storage-user-1');
    expect(reloadedAuth.getCurrentUser()?.id).toBe('user-1');
    expect(reloadedAuth.hasActiveSession()).toBe(false);
    expect(reloadedAuth.hasOfflineAccount()).toBe(true);
  });

  it('keeps offline identity when session verification is unavailable', async () => {
    const auth = await import('./auth');
    const status = migrationStatus('storage-user-1');
    auth.cacheOfflineAccount(status.user, status);
    getSessionMock.mockResolvedValue({
      data: null,
      error: { status: 0, message: 'Network unavailable' },
    });

    const result = await auth.restoreSessionState();

    expect(result.status).toBe('unavailable');
    expect(auth.getOfflineAccount()?.storageKey).toBe('storage-user-1');
    expect(auth.getCurrentUser()?.id).toBe('user-1');
  });

  it('deselects an account on explicit local sign-out without deleting its registry entry', async () => {
    const auth = await import('./auth');
    const status = migrationStatus('storage-user-1');
    auth.cacheOfflineAccount(status.user, status);

    auth.clearOfflineAccountSelection();

    expect(auth.getOfflineAccount()).toBeNull();
    const registry = JSON.parse(localStorage.getItem('gym21_offline_accounts_v1') || '{}');
    expect(registry.activeStorageKey).toBeNull();
    expect(registry.accounts['storage-user-1']).toBeTruthy();
  });

  it('locks local data immediately and completes a failed server sign-out after reconnect', async () => {
    const auth = await import('./auth');
    const status = migrationStatus('storage-user-1');
    auth.cacheOfflineAccount(status.user, status);
    signOutMock.mockRejectedValueOnce(new Error('Offline'));

    await auth.signOut();

    expect(auth.getOfflineAccount()).toBeNull();
    expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBe('1');

    signOutMock.mockResolvedValueOnce(undefined);
    vi.resetModules();
    const reloadedAuth = await import('./auth');
    const restore = await reloadedAuth.restoreSessionState();
    expect(restore.status).toBe('unauthenticated');
    expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBeNull();
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});

it('late 401 and restore responses cannot clear or replace account B', async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', createMemoryStorage());
  const auth = await import('./auth');
  const databases = await import('./db');
  const a = migrationStatus('late-a');
  auth.cacheOfflineAccount(a.user, a);
  getSessionMock.mockResolvedValue({ data: { session: {}, user: a.user } });
  await auth.restoreSessionState();
  await databases.activateAccountDatabase(a.storageKey);
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const pending = auth.authorizedApiFetch('/me/storage/sync');
  const rejected = expect(pending).rejects.toThrow('Stale account operation');
  let finishRestore!: (value: unknown) => void;
  getSessionMock.mockImplementation(() => new Promise(resolve => { finishRestore = resolve; }));
  const restoring = auth.restoreSessionState();
  const b = migrationStatus('late-b');
  b.user.id = 'user-b';
  auth.cacheOfflineAccount(b.user, b);
  getSessionMock.mockResolvedValue({ data: { session: {}, user: b.user } });
  await auth.restoreSessionState();
  await databases.activateAccountDatabase(b.storageKey);
  finish(new Response(null, { status: 401 }));
  await rejected;
  finishRestore({ data: { session: {}, user: a.user } });
  expect((await restoring).status).toBe('unavailable');
  expect(auth.getCurrentSession()?.user.id).toBe('user-b');
  expect(auth.getOfflineAccount()?.storageKey).toBe('late-b');
});

it('auth channel invalidates received changes without rebroadcasting read-only verification', async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', createMemoryStorage());
  const postMessage = vi.fn();
  const channels: Array<{ onmessage?: (event: { data: unknown }) => void }> = [];
  vi.stubGlobal('BroadcastChannel', class {
    onmessage?: (event: { data: unknown }) => void;
    postMessage = postMessage;
    constructor() { channels.push(this); }
  });
  const auth = await import('./auth');
  const status = migrationStatus('channel-a');
  auth.cacheOfflineAccount(status.user, status);
  getSessionMock.mockResolvedValue({ data: { session: {}, user: status.user } });
  await auth.restoreSessionState();
  await auth.restoreSessionState();
  expect(postMessage).not.toHaveBeenCalled();
  channels[0].onmessage?.({ data: { type: 'auth-changed' } });
  expect(auth.hasActiveSession()).toBe(false);
  expect(auth.hasOfflineAccount()).toBe(false);
  expect(postMessage).not.toHaveBeenCalled();
  auth.clearAuthState();
  expect(postMessage).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});
