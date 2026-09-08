import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from './application';
import type { UiDependencies } from './dependencies';
import type { SyncStatus } from '../storage/storage';
import { createLifecycle } from './lifecycle';
import { PublicHistoryStaleError } from '../storage/remote-reads';
import type { PublicProfileData } from '../types';

const apps: Array<ReturnType<typeof createApplication>> = [];
afterEach(() => {
  apps.splice(0).forEach(app => app.dispose());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(overrides: Partial<UiDependencies> = {}) {
  document.body.innerHTML = '<div id="app"></div>';
  const unsubscribes = [vi.fn(), vi.fn(), vi.fn()];
  let refresh = () => { };
  let statusChange: (status: SyncStatus) => void = () => { };
  let syncState = { pendingCount: 0, error: undefined as { message: string } | undefined };
  const storage = {
    isActive: () => true, getStorageKey: () => 'fixture',
    getSyncState: vi.fn(() => syncState), sync: vi.fn(async () => { }),
    getWorkoutTypes: () => [], getLogs: () => [], getWorkouts: () => [], getLatestLog: () => undefined, getLogsInDayRange: () => [],
    getTimeZone: () => 'UTC', getProfile: () => ({ isPublic: false }),
    getActiveWorkout: () => ({ id: 'w', startTime: new Date().toISOString(), status: 'active', pauseIntervals: [] }),
    onUpdate: vi.fn((callback: () => void) => { refresh = callback; return unsubscribes[0]; }),
    onSyncStatusChange: vi.fn((callback: typeof statusChange) => { statusChange = callback; return unsubscribes[1]; }),
    onUnauthorized: vi.fn(() => unsubscribes[2]),
  };
  const app = createApplication({
    storage, hasActiveSession: () => true, captureAccountContext: () => ({ storageKey: 'fixture' }), getCurrentUser: () => ({ name: 'Fixture' }),
    ...overrides,
  } as unknown as Partial<UiDependencies>);
  apps.push(app);
  return { app, storage, unsubscribes, refresh: () => refresh(), emit: (status: SyncStatus, pendingCount = 0, message?: string) => { syncState = { pendingCount, error: message ? { message } : undefined }; statusChange(status); } };
}

describe('application mount and dispose', () => {
  it('loads public history pages, preserves the full heatmap, and visibly restarts stale history', async () => {
    const makePage = (id: string, nextCursor: string | null): PublicProfileData => ({
      displayName: 'Public', identifier: 'public', stats: { totalWorkouts: 12, totalVolume: 120 }, recentActivity: [],
      activityDays: ['2026-08-01'], logs: [{ id, workoutTypeId: 'T', date: '2026-09-01T00:00:00Z', reps: 2 }],
      workoutTypes: [{ id: 'T', name: 'Test' }], history: { nextCursor },
    });
    const read = vi.fn().mockResolvedValueOnce(makePage('A', 'next')).mockResolvedValueOnce(makePage('B', 'last'))
      .mockRejectedValueOnce(new PublicHistoryStaleError()).mockResolvedValueOnce(makePage('C', null));
    const { app } = fixture({ getCurrentUser: () => null, storage: { getPublicProfile: read } as unknown as UiDependencies['storage'] });
    app.navigate({ name: 'public-profile', identifier: 'public' });
    await vi.waitFor(() => expect(document.querySelector('#public-history-more')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('#public-history-more')!.click();
    await vi.waitFor(() => expect(app.state.loadedPublicProfile?.logs?.length).toBe(2));
    expect(read).toHaveBeenLastCalledWith('public', 'next');
    expect(app.state.loadedPublicProfile?.activityDays).toEqual(['2026-08-01']);
    document.querySelector<HTMLButtonElement>('#public-history-more')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toContain('История изменилась'));
    expect(document.querySelector('#public-history-more')).toBeNull();
    document.querySelector<HTMLButtonElement>('#public-profile-retry')!.click();
    await vi.waitFor(() => expect(app.state.loadedPublicProfile?.logs?.map(log => log.id)).toEqual(['C']));
    expect(read).toHaveBeenLastCalledWith('public');
  });

  it('does not merge a late history page after navigating away', async () => {
    let resolvePage!: (page: PublicProfileData) => void;
    const first: PublicProfileData = { displayName: 'Public', identifier: 'public', stats: { totalWorkouts: 1, totalVolume: 1 }, recentActivity: [],
      logs: [{ id: 'A', workoutTypeId: 'T', date: '2026-09-01T00:00:00Z' }], workoutTypes: [], history: { nextCursor: 'next' } };
    const read = vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
    const { app } = fixture({ getCurrentUser: () => null, storage: { getPublicProfile: read } as unknown as UiDependencies['storage'] });
    app.navigate({ name: 'public-profile', identifier: 'public' });
    await vi.waitFor(() => expect(document.querySelector('#public-history-more')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('#public-history-more')!.click();
    app.dispose();
    resolvePage({ ...first, logs: [{ ...first.logs![0], id: 'late' }] });
    await Promise.resolve();
    expect(document.querySelector('#app')?.childElementCount).toBe(0);
    expect(app.state.loadedPublicProfile?.logs?.some(log => log.id === 'late')).not.toBe(true);
  });

  it('owns subscriptions once, stops the workout timer on navigation, and releases detached controls', async () => {
    vi.useFakeTimers();
    const { app, storage, unsubscribes, refresh } = fixture();
    await app.mount({ bootstrap: false });
    await app.mount({ bootstrap: false });
    app.navigate({ name: 'main' });
    expect(vi.getTimerCount()).toBe(1);
    const oldNavigation = document.querySelector<HTMLElement>('[data-page=settings]')!;
    app.navigate({ name: 'settings' });
    expect(vi.getTimerCount()).toBe(0);
    app.navigate({ name: 'main' });
    oldNavigation.click();
    expect(app.state.currentRoute.name).toBe('main');
    app.dispose();
    app.dispose();
    refresh();
    expect(document.querySelector('#app')?.childElementCount).toBe(0);
    expect(document.querySelector('.sync-status')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(storage.onUpdate).toHaveBeenCalledTimes(1);
    expect(storage.onSyncStatusChange).toHaveBeenCalledTimes(1);
    unsubscribes.forEach(unsubscribe => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });

  it('renders one indicator across states, network events and page rerenders with actionable retry', async () => {
    const { app, storage, emit } = fixture();
    await app.mount({ bootstrap: false });
    app.navigate({ name: 'settings' });
    const indicator = document.querySelector<HTMLElement>('.sync-status')!;
    expect(indicator.hidden).toBe(true);
    emit('saving', 3);
    expect(indicator.textContent).toBe('Синхронизация... · Ожидают отправки: 3');
    emit('success');
    expect(indicator.textContent).toBe('Синхронизировано');
    emit('error', 2, '<record> слишком большой');
    expect(indicator.textContent).toContain('<record> слишком большой · Ожидают отправки: 2');
    expect(indicator.querySelector('record')).toBeNull();
    const detachedRetry = indicator.querySelector('button')!;
    app.render();
    detachedRetry.click();
    expect(storage.sync).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.sync-status')).toHaveLength(1);
    indicator.querySelector('button')!.click();
    expect(storage.sync).toHaveBeenCalledOnce();
    emit('idle', 2);
    expect(indicator.textContent).toBe('Ожидают отправки: 2');
    emit('idle');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    expect(indicator.textContent).toContain('изменения сохраняются на устройстве');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(indicator.hidden).toBe(true);
    emit('error');
    const disposedRetry = indicator.querySelector('button')!;
    app.dispose();
    disposedRetry.click();
    emit('saving');
    window.dispatchEvent(new Event('offline'));
    expect(storage.sync).toHaveBeenCalledOnce();
    expect(document.querySelector('.sync-status')).toBeNull();
  });

  it('clears private status on auth loss and never reads personal sync state for guests', async () => {
    let user = { name: 'Fixture' } as ReturnType<UiDependencies['getCurrentUser']>;
    const { app, storage, emit } = fixture({ getCurrentUser: () => user });
    await app.mount({ bootstrap: false });
    emit('error', 9, 'Private record');
    user = null;
    storage.getSyncState.mockClear();
    window.dispatchEvent(new Event('gym21-auth-changed'));
    emit('error', 9, 'Private record');
    const indicator = document.querySelector<HTMLElement>('.sync-status')!;
    expect(indicator.hidden).toBe(true);
    expect(indicator.textContent).toBe('');
    expect(storage.getSyncState).not.toHaveBeenCalled();
    user = { name: 'New account' } as ReturnType<UiDependencies['getCurrentUser']>;
    storage.isActive = () => false;
    window.dispatchEvent(new Event('online'));
    expect(indicator.hidden).toBe(true);
    expect(storage.getSyncState).not.toHaveBeenCalled();
    storage.isActive = () => true;
    storage.getStorageKey = () => 'new-account';
    storage.getSyncState.mockReturnValue({ pendingCount: 0, error: undefined });
    window.dispatchEvent(new Event('online'));
    expect(app.state.syncStatus).toBe('idle');
    expect(indicator.hidden).toBe(true);
  });

  it('routes offline-account retry through reconnect instead of manual sync', async () => {
    const retry = vi.fn(async () => { });
    const { app, storage, emit } = fixture({
      hasActiveSession: () => false,
      getOfflineAccount: () => null,
      loadTelegramWebApp: async () => null,
      createReconnectCoordinator: () => ({ retry, dispose: vi.fn() }),
    });
    await app.mount();
    emit('idle', 1);
    expect(document.querySelector('.sync-status')?.textContent).toContain('изменения сохраняются на устройстве');
    document.querySelector<HTMLButtonElement>('.sync-status button')!.click();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(storage.sync).not.toHaveBeenCalled();
  });

  it('ignores a public response completing after disposal and keeps state private to each instance', async () => {
    let resolveProfile!: (profile: null) => void;
    const { app } = fixture();
    const guest = fixture({
      getCurrentUser: () => null,
      storage: { getPublicProfile: () => new Promise(resolve => { resolveProfile = resolve; }) } as unknown as UiDependencies['storage'],
    }).app;
    guest.navigate({ name: 'public-profile', identifier: 'slow' });
    expect(guest.state.currentRoute).toEqual({ name: 'public-profile', identifier: 'slow' });
    expect(app.state.currentRoute).toEqual({ name: 'main' });
    guest.dispose();
    resolveProfile(null);
    await Promise.resolve();
    expect(document.querySelector('#app')?.childElementCount).toBe(0);
    expect(guest.state.profileLoadFailed).toBe(false);
  });

  it('releases router/reconnect on disposal and does not resume a deferred activation', async () => {
    let finishActivation!: () => void;
    const router = { start: vi.fn(async () => { }), navigate: vi.fn(), dispose: vi.fn(), getCurrentRoute: () => ({ name: 'main' as const }) };
    const coordinator = vi.fn();
    const { app } = fixture({
      loadTelegramWebApp: vi.fn(async () => null),
      createRouterController: () => router,
      getOfflineAccount: () => ({ storageKey: 'fixture', migrationStatus: {} }) as ReturnType<UiDependencies['getOfflineAccount']>,
      storage: { activate: () => new Promise<void>(resolve => { finishActivation = resolve; }), onUpdate: () => () => { }, onUnauthorized: () => () => { }, onSyncStatusChange: () => () => { } } as unknown as UiDependencies['storage'],
      createReconnectCoordinator: coordinator,
    });
    const pending = app.mount();
    app.dispose();
    finishActivation();
    await pending;
    expect(router.dispose).toHaveBeenCalledOnce();
    expect(router.start).not.toHaveBeenCalled();
    expect(coordinator).not.toHaveBeenCalled();
  });

  it('sweeps listeners for detached partial content without affecting retained controls', () => {
    const lifecycle = createLifecycle();
    const retained = document.createElement('button');
    const replaced = document.createElement('button');
    document.body.append(retained, replaced);
    const click = vi.fn();
    lifecycle.listen(retained, 'click', click);
    lifecycle.listen(replaced, 'click', click);
    replaced.remove();
    lifecycle.sweep();
    replaced.click();
    expect(click).not.toHaveBeenCalled();
    retained.click();
    expect(click).toHaveBeenCalledOnce();
    lifecycle.dispose();
    retained.click();
    expect(click).toHaveBeenCalledOnce();
  });
});
