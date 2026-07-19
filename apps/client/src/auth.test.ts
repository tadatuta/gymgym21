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
