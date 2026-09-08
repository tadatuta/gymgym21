import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const signOutMock = vi.hoisted(() => vi.fn());
const signInMock = vi.hoisted(() => vi.fn());

vi.mock('@better-auth/passkey/client', () => ({
  passkeyClient: () => ({}),
}));

vi.mock('better-auth/client', () => ({
  createAuthClient: () => ({
    getSession: getSessionMock,
    signOut: signOutMock,
    signIn: {
      email: signInMock,
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
    expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBeTruthy();

    signOutMock.mockResolvedValueOnce({ data: { success: true }, error: null });
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


describe('durable sign-out', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createMemoryStorage());
    getSessionMock.mockReset();
    signOutMock.mockReset();
    signInMock.mockReset();
  });

  it('locks before network completion, preserves accounts, and retains resolved SDK errors across startup retries', async () => {
    const auth = await import('./auth');
    const status = migrationStatus('pending-a');
    auth.cacheOfflineAccount(status.user, status);
    let finish!: (value: unknown) => void;
    signOutMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const exiting = auth.signOut();
    expect(auth.getCurrentUser()).toBeNull();
    expect(auth.hasOfflineAccount()).toBe(false);
    expect(JSON.parse(localStorage.getItem('gym21_offline_accounts_v1')!).accounts['pending-a']).toBeTruthy();
    const marker = localStorage.getItem('gym21_pending_sign_out_v1');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish({ data: null, error: { status: 503, message: 'Unavailable' } });
    await exiting;
    expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBe(marker);
    vi.resetModules();
    const reloaded = await import('./auth');
    signOutMock.mockResolvedValue({ data: null, error: { status: 503 } });
    expect((await reloaded.restoreSessionState()).status).toBe('unavailable');
    expect((await reloaded.restoreSessionState()).status).toBe('unavailable');
    expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBe(marker);
    expect(getSessionMock).not.toHaveBeenCalled();
    signOutMock.mockResolvedValue({ data: { success: true }, error: null });
    expect((await reloaded.restoreSessionState()).status).toBe('unauthenticated');
    expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBeNull();
  });

  it('serializes a new login behind an outstanding logout and never replays it against B', async () => {
    const auth = await import('./auth');
    let finish!: (value: unknown) => void;
    signOutMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const exiting = auth.signOut();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const b = { ...migrationStatus('b').user, id: 'user-b' };
    signInMock.mockResolvedValue({ data: { user: b }, error: null });
    getSessionMock.mockResolvedValue({ data: { session: {}, user: b }, error: null });
    const entering = auth.signInWithEmail('b@example.com', 'test');
    await Promise.resolve();
    expect(signInMock).not.toHaveBeenCalled();
    finish({ data: { success: true }, error: null });
    await exiting;
    expect((await entering).user.id).toBe('user-b');
    await auth.restoreSessionState();
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(auth.getCurrentUser()?.id).toBe('user-b');
  });

  it('cancels a queued login when a later logout is the latest user intent', async () => {
    const auth = await import('./auth');
    let finish!: (value: unknown) => void;
    signOutMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = auth.signOut();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const entering = auth.signInWithEmail('b@example.com', 'test');
    const rejected = expect(entering).rejects.toThrow('Stale auth operation');
    const last = auth.signOut();
    signOutMock.mockResolvedValue({ data: { success: true }, error: null });
    finish({ data: { success: true }, error: null });
    await Promise.all([first, last, rejected]);
    expect(signInMock).not.toHaveBeenCalled();
    expect(auth.getCurrentUser()).toBeNull();
    expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBeNull();
  });

  it('does not delete a newer pending intent when an older response succeeds', async () => {
    const auth = await import('./auth');
    let finish!: (value: unknown) => void;
    signOutMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const exiting = auth.signOut();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    localStorage.setItem('gym21_pending_sign_out_v1', 'newer-intent');
    finish({ data: { success: true }, error: null });
    await exiting;
    expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBe('newer-intent');
  });
});

for (const body of [JSON.stringify({ code: 'backup_revision_conflict' }), JSON.stringify({ code: 'AI_CONTEXT_STALE' }), 'invalid JSON']) {
  it(`preserves verified identity and response body for recoverable 409: ${body}`, async () => {
    vi.resetModules(); vi.stubGlobal('localStorage', createMemoryStorage());
    const auth = await import('./auth'); const databases = await import('./db');
    const status = migrationStatus(`conflict-${Math.random()}`);
    auth.cacheOfflineAccount(status.user, status);
    getSessionMock.mockResolvedValue({ data: { session: {}, user: status.user } });
    await auth.restoreSessionState(); await databases.activateAccountDatabase(status.storageKey);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 409 })));
    const response = await auth.authorizedApiFetch('/me/storage/backup');
    expect(await response.text()).toBe(body);
    expect(auth.hasVerifiedOnlineAccount(status.storageKey)).toBe(true);
    expect(databases.captureAccountContext().isCurrent()).toBe(true);
  });
}
it('only explicit account mismatch 409 locks the current identity', async () => {
  vi.resetModules(); vi.stubGlobal('localStorage', createMemoryStorage());
  const auth = await import('./auth'); const databases = await import('./db');
  const status = migrationStatus('mismatch-current'); auth.cacheOfflineAccount(status.user, status);
  getSessionMock.mockResolvedValue({ data: { session: {}, user: status.user } });
  await auth.restoreSessionState(); await databases.activateAccountDatabase(status.storageKey);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'ACCOUNT_CONTEXT_MISMATCH' }), { status: 409 })));
  await auth.authorizedApiFetch('/me/storage/sync');
  expect(auth.hasActiveSession()).toBe(false); expect(auth.getOfflineAccount()).toBeNull();
});
it('a delayed mismatch body cannot invalidate a newer account', async () => {
  vi.resetModules(); vi.stubGlobal('localStorage', createMemoryStorage());
  const auth = await import('./auth'); const databases = await import('./db');
  const a = migrationStatus('body-a'); auth.cacheOfflineAccount(a.user, a);
  getSessionMock.mockResolvedValue({ data: { session: {}, user: a.user } });
  await auth.restoreSessionState(); await databases.activateAccountDatabase(a.storageKey);
  let release!: (body: unknown) => void;
  const parsing = new Promise(resolve => { release = resolve; });
  const response = new Response('', { status: 409 });
  vi.spyOn(response, 'clone').mockReturnValue({ json: () => parsing } as Response);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const request = auth.authorizedApiFetch('/me/storage/sync');
  const rejected = expect(request).rejects.toThrow('Stale account operation');
  await vi.waitFor(() => expect(response.clone).toHaveBeenCalledOnce());
  const b = migrationStatus('body-b'); b.user.id = 'new-user'; auth.cacheOfflineAccount(b.user, b);
  getSessionMock.mockResolvedValue({ data: { session: {}, user: b.user } });
  await auth.restoreSessionState(); await databases.activateAccountDatabase(b.storageKey);
  release({ code: 'ACCOUNT_CONTEXT_MISMATCH' }); await rejected;
  expect(auth.hasVerifiedOnlineAccount(b.storageKey)).toBe(true);
});
