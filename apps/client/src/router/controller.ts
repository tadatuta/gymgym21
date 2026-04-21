import { type AppRoute, buildUrl, resolveRoute } from './index';

type RouteChangeSource = 'start' | 'navigate' | 'popstate';

interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

interface WindowLike {
  location: {
    pathname: string;
    search: string;
  };
  history: HistoryLike;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

interface CommitRouteOptions {
  replace?: boolean;
  syncHistory?: boolean;
  source: RouteChangeSource;
}

export interface RouteChangeContext {
  previousRoute: AppRoute;
  source: RouteChangeSource;
}

interface RouterControllerOptions {
  window: WindowLike;
  onRouteChange: (route: AppRoute, context: RouteChangeContext) => Promise<void> | void;
}

export interface RouterController {
  getCurrentRoute(): AppRoute;
  navigate(route: AppRoute, options?: { replace?: boolean }): void;
  start(): Promise<void>;
  dispose(): void;
}

function getCurrentUrl(windowLike: WindowLike) {
  return `${windowLike.location.pathname}${windowLike.location.search}`;
}

function syncHistory(windowLike: WindowLike, route: AppRoute, replace = false) {
  const nextUrl = buildUrl(route);
  if (getCurrentUrl(windowLike) === nextUrl) {
    return;
  }

  const historyMethod = replace ? 'replaceState' : 'pushState';
  windowLike.history[historyMethod](null, '', nextUrl);
}

export function createRouterController(options: RouterControllerOptions): RouterController {
  const { window: windowLike, onRouteChange } = options;
  let currentRoute = resolveRoute(windowLike.location).route;
  let started = false;

  const commitRoute = async (route: AppRoute, commitOptions: CommitRouteOptions) => {
    const previousRoute = currentRoute;
    currentRoute = route;

    if (commitOptions.syncHistory) {
      syncHistory(windowLike, route, commitOptions.replace);
    }

    await onRouteChange(route, {
      previousRoute,
      source: commitOptions.source,
    });
  };

  const applyResolvedLocation = async (source: RouteChangeSource) => {
    const resolvedRoute = resolveRoute(windowLike.location);
    await commitRoute(resolvedRoute.route, {
      replace: resolvedRoute.shouldReplace,
      syncHistory: resolvedRoute.shouldReplace,
      source,
    });
  };

  const handlePopState = () => {
    void applyResolvedLocation('popstate');
  };

  return {
    getCurrentRoute() {
      return currentRoute;
    },
    navigate(route, navigateOptions) {
      void commitRoute(route, {
        replace: navigateOptions?.replace,
        syncHistory: true,
        source: 'navigate',
      });
    },
    async start() {
      if (started) {
        return;
      }

      started = true;
      windowLike.addEventListener('popstate', handlePopState);
      await applyResolvedLocation('start');
    },
    dispose() {
      if (!started) {
        return;
      }

      started = false;
      windowLike.removeEventListener('popstate', handlePopState);
    },
  };
}
