import type { OfflineAccount } from '../auth';
import { disposeLogin, renderLogin } from '../components/auth/Login';
import {
  type AppRoute,
  createInternalRoute,
  type InternalRouteName,
  isSameRoute
} from '../router';
import type { SyncStatus } from '../storage/storage';
import { FormDrafts } from '../utils/form-drafts';
import type { PageContext } from './context';
import { defaultDependencies, type UiDependencies } from './dependencies';
import { createLifecycle } from './lifecycle';
import { createProfilePage } from './pages/profile';
import { createPublicPage } from './pages/public';
import { createSettingsPage } from './pages/settings';
import { createStatsPage } from './pages/stats';
import { createWorkoutPage } from './pages/workout';
import { createUiState } from './state';

/** Composes page instances and owns their account, route and DOM lifetime. */
export function createApplication(dependencyOverrides: Partial<UiDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const {
    storage, captureAccountContext, loadTelegramWebApp, createReconnectCoordinator,
    createRouterController, cacheOfflineAccount, clearAuthState, getCurrentSession,
    getCurrentUser, getOfflineAccount, getMigrationStatus, hasActiveSession, restoreSessionState,
  } = dependencies;
  const state = createUiState();
  const lifecycle = createLifecycle();
  const statusLifecycle = createLifecycle();
  let disposed = false;
  let mounted = false;
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnect: ReturnType<typeof createReconnectCoordinator> | undefined;
  const cleanups: Array<() => void> = [];
  const context: PageContext = {
    state, dependencies,
    actions: {
      render, navigate, showToast, withFormDrafts, bindRouteLinks, loadPublicProfile,
      generateLogsListHtml: (...args) => pages.workout.generateLogsListHtml(...args),
      getPreferredDisplayName: value => pages.profile.getPreferredDisplayName(value),
    },
  };
  const pages = {
    workout: createWorkoutPage(context), settings: createSettingsPage(context),
    profile: createProfilePage(context), stats: createStatsPage(context), public: createPublicPage(context),
  };
  const routes = {
    main: pages.workout, settings: pages.settings, 'profile-settings': pages.profile,
    stats: pages.stats, 'public-profile': pages.public,
  };
  function currentPageModule() { return routes[state.currentRoute.name]; }
  function disposePage() { Object.values(pages).forEach(page => page.dispose()); lifecycle.dispose(); }
  function loadPublicProfile(identifier: string) { return pages.public.loadPublicProfile(identifier); }
  const routerController = createRouterController({ window, onRouteChange: (route, context) => handleRouteChange(route, context.previousRoute) });
  const syncStatusEl = document.createElement('div');
  syncStatusEl.className = 'sync-status';
  function withFormDrafts(update: () => void) {
    if (disposed) return;
    const app = document.getElementById('app');
    if (!app) return;
    state.formDrafts ??= new FormDrafts(app);
    state.formDrafts.render(captureAccountContext().storageKey, group => JSON.stringify([
      state.currentRoute, group.id,
      group.id === 'profile-tab-content' ? state.currentProfileTab : '',
      group.id === 'log-form' ? state.editingLogId : group.id === 'add-type-form' ? state.editingTypeId : group.id === 'workout-edit-form' ? state.editingWorkoutId : '',
    ]), update);
    lifecycle.sweep();
    Object.values(pages).forEach(page => page.sweep());
  }

  function getCurrentPage() {
    return state.currentRoute.name;
  }

  async function handleRouteChange(route: AppRoute, previousRoute: AppRoute) {
    const routeChanged = !isSameRoute(previousRoute, route);
    state.currentRoute = route;
    state.guestLoginRequested = false;

    if (route.name === 'public-profile') {
      if (pages.public.shouldReloadPublicProfile(route)) {
        await loadPublicProfile(route.identifier);
        return;
      }

      render();
      return;
    }

    if (previousRoute.name === 'public-profile' || routeChanged) {
      state.publicProfileRequestId += 1;
      pages.public.clearPublicProfileState();
    }

    render();
  }

  function navigate(route: AppRoute, options?: { replace?: boolean }) {
    routerController.navigate(route, options);
  }

  function bindRouteLinks(root: ParentNode = document) {
    root.querySelectorAll<HTMLElement>('[data-route-kind="public-profile"]').forEach((link) => {
      lifecycle.listen(link, 'click', (event) => {
        if (event instanceof MouseEvent && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
          return;
        }

        const identifier = link.getAttribute('data-profile-identifier');
        if (!identifier) {
          return;
        }

        event.preventDefault();
        navigate({ name: 'public-profile', identifier });
      });
    });
  }

  function showToast(message: string) {
    if (disposed) return;
    let toastEl = document.querySelector('.toast');
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('visible');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toastEl?.classList.remove('visible');
    }, 2000);
  }

  function render() {
    withFormDrafts(renderContent);
  }

  function disposeMainLogin(app: HTMLElement) {
    disposeLogin(app);
    if (state.guestLoginHost) disposeLogin(state.guestLoginHost);
    state.guestLoginHost = null;
  }

  function showGuestLogin(error?: string) {
    if (disposed) return;
    if (state.guestLoginHost?.isConnected) return;
    disposePage();
    const app = document.getElementById('app');
    if (!app) return;
    state.formDrafts?.dispose();
    state.formDrafts = null;
    disposeMainLogin(app);
    app.replaceChildren();
    state.guestLoginHost = document.createElement('div');
    app.append(state.guestLoginHost);
    void renderLogin(state.guestLoginHost, () => location.reload(), error);
    if (state.currentRoute.name === 'public-profile') {
      const back = document.createElement('button');
      back.className = 'button button_secondary';
      back.textContent = 'Назад к профилю';
      back.id = 'guest-profile-back';
      lifecycle.listen(back, 'click', () => { state.guestLoginRequested = false; render(); });
      app.prepend(back);
    }
  }

  function renderContent() {
    if (disposed) return;
    if (!getCurrentUser() && state.guestLoginHost?.isConnected && (state.currentRoute.name !== 'public-profile' || state.guestLoginRequested)) return;
    disposePage();
    const app = document.getElementById('app');
    if (!app) return;

    if (!getCurrentUser()) {
      if (state.currentRoute.name !== 'public-profile' || state.guestLoginRequested) {
        showGuestLogin();
        return;
      }
      disposeMainLogin(app);
      app.innerHTML = `<main class="content">${pages.public.render()}
      <button class="button" id="guest-sign-in">Войти в свой аккаунт</button></main>`;
      lifecycle.listen(app.querySelector('#public-profile-retry'), 'click', () => {
        if (state.currentRoute.name === 'public-profile') void loadPublicProfile(state.currentRoute.identifier);
      });
      lifecycle.listen(app.querySelector('#guest-sign-in'), 'click', () => {
        state.guestLoginRequested = true;
        window.history.pushState(null, '', window.location.href);
        showGuestLogin();
      });
      return;
    }

    const currentPage = getCurrentPage();

    disposeMainLogin(app);
    app.innerHTML = `
    <main class="content">
      ${currentPageModule().render()}
    </main>
    <nav class="navigation">
      <button class="navigation__item ${currentPage === 'main' ? 'navigation__item_active' : ''}" data-page="main">
        <span class="navigation__icon">🏋️</span>
        <span class="navigation__label">Тренировка</span>
      </button>
      <button class="navigation__item ${currentPage === 'stats' ? 'navigation__item_active' : ''}" data-page="stats">
        <span class="navigation__icon">📊</span>
        <span class="navigation__label">Статистика</span>
      </button>
      <button class="navigation__item ${currentPage === 'profile-settings' ? 'navigation__item_active' : ''}" data-page="profile-settings">
        <span class="navigation__icon">👤</span>
        <span class="navigation__label">Профиль</span>
      </button>
      <button class="navigation__item ${currentPage === 'settings' ? 'navigation__item_active' : ''}" data-page="settings">
        <span class="navigation__icon">⚙️</span>
        <span class="navigation__label">Настройки</span>
      </button>
    </nav>
    <div id="sync-status" class="sync-status"></div>
  `;

    // Bind events
    app.querySelectorAll('.navigation__item').forEach(item => {
      lifecycle.listen(item, 'click', () => {
        const page = item.getAttribute('data-page') as InternalRouteName;
        navigate(createInternalRoute(page));
      });
    });

    bindRouteLinks();
    currentPageModule().mount();
  }

  function updateSyncStatusUI() {
    const statusEl = document.getElementById('sync-status');
    if (!statusEl) return;

    statusEl.className = 'sync-status';
    let text = '';
    let icon = '';

    switch (state.syncStatus) {
      case 'saving':
        text = 'Синхронизация...';
        icon = '🔄';
        statusEl.classList.add('sync-status_saving');
        break;
      case 'success':
        text = 'Сохранено';
        icon = '✅';
        statusEl.classList.add('sync-status_success');
        break;
      case 'error':
        text = 'Ошибка синхронизации';
        icon = '⚠️';
        statusEl.classList.add('sync-status_error');
        break;
      case 'idle':
        if (!navigator.onLine) {
          text = 'Оффлайн';
          icon = '📡';
          statusEl.classList.add('sync-status_offline');
        } else {
          return; // Hide if idle and online
        }
        break;
    }

    statusEl.innerHTML = `${icon} ${text}`;
  }

  function updateSyncStatus(status: SyncStatus) {
    if (disposed) return;
    statusLifecycle.dispose();
    syncStatusEl.replaceChildren();
    syncStatusEl.className = 'sync-status visible ' + status;

    switch (status) {
      case 'saving':
        syncStatusEl.textContent = 'Синхронизация...';
        break;
      case 'success':
        syncStatusEl.textContent = 'Синхронизировано';
        break;
      case 'error':
        syncStatusEl.textContent = storage.getSyncState().error?.message ?? 'Ошибка синхронизации';
        break;
      default:
        if (!navigator.onLine || !hasActiveSession()) {
          syncStatusEl.className = 'sync-status visible idle';
          syncStatusEl.textContent = 'Оффлайн · изменения сохраняются на устройстве';
        } else {
          syncStatusEl.className = 'sync-status';
        }
    }
    const pending = storage.getSyncState().pendingCount;
    if (pending) {
      syncStatusEl.classList.add('visible');
      syncStatusEl.appendChild(document.createTextNode(` · Ожидают отправки: ${pending}`));
    }
    if (status === 'error' || !hasActiveSession()) {
      const retry = document.createElement('button');
      retry.className = 'button button_secondary';
      retry.textContent = 'Повторить подключение';
      statusLifecycle.listen(retry, 'click', () => { if (hasActiveSession()) void storage.sync(); else void reconnect?.retry(); });
      syncStatusEl.appendChild(retry);
    }

  }
  async function initApp() {
    void loadTelegramWebApp();
    const showLogin = (error?: string) => {
      if (state.currentRoute.name === 'public-profile' && !state.guestLoginRequested) {
        render();
        return;
      }
      showGuestLogin(error);
    };
    // Public routes must work without opening a personal database or restoring a session.
    if (routerController.getCurrentRoute().name === 'public-profile') void routerController.start();
    const activateLocalAccount = async (account: OfflineAccount) => {
      state.authStatus = account.migrationStatus;
      await storage.activate(account.storageKey);
      if (disposed) return;
      const context = captureAccountContext();
      const cachedResults = await storage.readCachedAIResults();
      if (disposed || !context.isCurrent()) return;
      state.aiResults = cachedResults;
      await routerController.start();
      if (state.currentRoute.name === 'public-profile') await loadPublicProfile(state.currentRoute.identifier);
      else render();
      updateSyncStatus('idle');
    };

    const cachedAccount = getOfflineAccount();
    if (cachedAccount) {
      await activateLocalAccount(cachedAccount);
    }

    if (disposed) return;
    reconnect = createReconnectCoordinator({
      events: window,
      restore: restoreSessionState,
      verify: getMigrationStatus,
      isSessionCurrent: (session) => getCurrentSession() === session,
      captureGuard: () => captureAccountContext().isCurrent,
      activate: async (session, status) => {
        const account = cacheOfflineAccount(session.user, status);
        await activateLocalAccount(account);
      },
      sync: () => storage.sync(),
      onUnavailable: () => {
        updateSyncStatus('error');
        if (!getCurrentUser()) showLogin('Нет подключения к серверу. Первый вход на этом устройстве требует интернет.');
      },
      onUnauthenticated: () => {
        clearAuthState({ clearOfflineAccount: true, broadcast: false });
        showLogin();
      },
      onIncomplete: () => showLogin(),
    });
    await reconnect.retry();
  }
  function subscribe() {
    cleanups.push(storage.onUpdate(() => { if (!disposed) currentPageModule().refresh(); }));
    cleanups.push(storage.onSyncStatusChange(status => { state.syncStatus = status; updateSyncStatus(status); }));
    cleanups.push(storage.onUnauthorized(() => { state.formDrafts?.dispose(); state.formDrafts = null; state.authStatus = null; showGuestLogin(); }));
    window.addEventListener('online', updateSyncStatusUI);
    window.addEventListener('offline', updateSyncStatusUI);
    cleanups.push(() => { window.removeEventListener('online', updateSyncStatusUI); window.removeEventListener('offline', updateSyncStatusUI); });
  }
  return {
    state, pages, render,
    mount(options: { bootstrap?: boolean } = {}) {
      if (mounted || disposed) return Promise.resolve();
      mounted = true;
      document.body.appendChild(syncStatusEl);
      subscribe();
      return options.bootstrap === false ? Promise.resolve() : initApp();
    },
    navigate,
    dispose() {
      if (disposed) return;
      disposed = true;
      state.publicProfileRequestId++;
      reconnect?.dispose();
      routerController.dispose();
      disposePage();
      statusLifecycle.dispose();
      cleanups.splice(0).forEach(cleanup => cleanup?.());
      state.formDrafts?.dispose(); state.formDrafts = null;
      const app = document.getElementById('app');
      if (app) {
        disposeMainLogin(app);
        app.replaceChildren();
      }
      if (toastTimeout) clearTimeout(toastTimeout);
      document.querySelector('.toast')?.remove(); syncStatusEl.remove();
    }
  };
}
