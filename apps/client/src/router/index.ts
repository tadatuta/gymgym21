export type InternalRouteName = 'main' | 'stats' | 'settings' | 'profile-settings';
export type RouteName = InternalRouteName | 'public-profile';

export type AppRoute =
  | { name: 'main' }
  | { name: 'stats' }
  | { name: 'settings' }
  | { name: 'profile-settings' }
  | { name: 'public-profile'; identifier: string };

export interface RouteResolution {
  route: AppRoute;
  canonicalUrl: string;
  shouldReplace: boolean;
}

interface LocationLike {
  pathname: string;
  search: string;
}

const PROFILE_STARTAPP_PREFIX = 'profile_';

function normalizeProfileIdentifier(identifier: string): string | null {
  const normalized = identifier.trim().replace(/^@/, '');
  return normalized ? normalized : null;
}

function parseInternalPage(page: string | null): InternalRouteName {
  switch (page) {
    case 'stats':
    case 'settings':
    case 'profile-settings':
      return page;
    default:
      return 'main';
  }
}

function parseProfileRoute(pathname: string): AppRoute | null {
  const match = pathname.match(/^\/profile\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }

  const identifier = normalizeProfileIdentifier(decodeURIComponent(match[1]));
  return identifier ? { name: 'public-profile', identifier } : null;
}

function parseStartAppRoute(searchParams: URLSearchParams): AppRoute | null {
  const startApp = searchParams.get('startapp');
  if (!startApp || !startApp.startsWith(PROFILE_STARTAPP_PREFIX)) {
    return null;
  }

  const identifier = normalizeProfileIdentifier(
    decodeURIComponent(startApp.slice(PROFILE_STARTAPP_PREFIX.length)),
  );

  return identifier ? { name: 'public-profile', identifier } : null;
}

export function createInternalRoute(name: InternalRouteName): AppRoute {
  return { name };
}

export function parseRoute(location: LocationLike): AppRoute {
  const searchParams = new URLSearchParams(location.search);

  return (
    parseStartAppRoute(searchParams) ??
    parseProfileRoute(location.pathname) ?? {
      name: parseInternalPage(searchParams.get('page')),
    }
  );
}

export function buildUrl(route: AppRoute): string {
  switch (route.name) {
    case 'main':
      return '/';
    case 'stats':
      return '/?page=stats';
    case 'settings':
      return '/?page=settings';
    case 'profile-settings':
      return '/?page=profile-settings';
    case 'public-profile':
      return `/profile/${encodeURIComponent(route.identifier)}`;
  }
}

export function resolveRoute(location: LocationLike): RouteResolution {
  const route = parseRoute(location);
  const canonicalUrl = buildUrl(route);
  const currentUrl = `${location.pathname}${location.search}`;

  return {
    route,
    canonicalUrl,
    shouldReplace: currentUrl !== canonicalUrl,
  };
}

export function isSameRoute(left: AppRoute, right: AppRoute): boolean {
  if (left.name !== right.name) {
    return false;
  }

  if (left.name === 'public-profile' && right.name === 'public-profile') {
    return left.identifier === right.identifier;
  }

  return true;
}
