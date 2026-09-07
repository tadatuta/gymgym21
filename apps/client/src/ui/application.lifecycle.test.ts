import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from './application';
import type { UiDependencies } from './dependencies';
import { createLifecycle } from './lifecycle';

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
  const storage = {
    getWorkoutTypes: () => [], getLogs: () => [], getWorkouts: () => [],
    getTimeZone: () => 'UTC', getProfile: () => ({ isPublic: false }),
    getActiveWorkout: () => ({ id: 'w', startTime: new Date().toISOString(), status: 'active', pauseIntervals: [] }),
    onUpdate: vi.fn((callback: () => void) => { refresh = callback; return unsubscribes[0]; }),
    onSyncStatusChange: vi.fn(() => unsubscribes[1]),
    onUnauthorized: vi.fn(() => unsubscribes[2]),
  };
  const app = createApplication({
    storage, captureAccountContext: () => ({ storageKey: 'fixture' }), getCurrentUser: () => ({ name: 'Fixture' }),
    ...overrides,
  } as unknown as Partial<UiDependencies>);
  apps.push(app);
  return { app, storage, unsubscribes, refresh: () => refresh() };
}

describe('application mount and dispose', () => {
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
    unsubscribes.forEach(unsubscribe => expect(unsubscribe).toHaveBeenCalledTimes(1));
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
