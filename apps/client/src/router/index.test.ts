import { describe, expect, it } from 'vitest';
import { buildUrl, isSameRoute, parseRoute, resolveRoute } from './index';

describe('router', () => {
  it('parses internal pages from the query string', () => {
    expect(parseRoute({ pathname: '/', search: '' })).toEqual({ name: 'main' });
    expect(parseRoute({ pathname: '/', search: '?page=stats' })).toEqual({ name: 'stats' });
    expect(parseRoute({ pathname: '/', search: '?page=settings' })).toEqual({ name: 'settings' });
    expect(parseRoute({ pathname: '/', search: '?page=profile-settings' })).toEqual({ name: 'profile-settings' });
  });

  it('parses public profile routes from canonical pathnames', () => {
    expect(parseRoute({ pathname: '/profile/alex', search: '' })).toEqual({
      name: 'public-profile',
      identifier: 'alex',
    });
    expect(parseRoute({ pathname: '/profile/%40alex/', search: '' })).toEqual({
      name: 'public-profile',
      identifier: 'alex',
    });
  });

  it('parses legacy telegram deep links and normalizes them', () => {
    const resolved = resolveRoute({
      pathname: '/',
      search: '?startapp=profile_john_doe',
    });

    expect(resolved.route).toEqual({ name: 'public-profile', identifier: 'john_doe' });
    expect(resolved.canonicalUrl).toBe('/profile/john_doe');
    expect(resolved.shouldReplace).toBe(true);
  });

  it('builds canonical urls for every route', () => {
    expect(buildUrl({ name: 'main' })).toBe('/');
    expect(buildUrl({ name: 'stats' })).toBe('/?page=stats');
    expect(buildUrl({ name: 'settings' })).toBe('/?page=settings');
    expect(buildUrl({ name: 'profile-settings' })).toBe('/?page=profile-settings');
    expect(buildUrl({ name: 'public-profile', identifier: 'id_123' })).toBe('/profile/id_123');
  });

  it('compares routes structurally', () => {
    expect(isSameRoute({ name: 'main' }, { name: 'main' })).toBe(true);
    expect(
      isSameRoute(
        { name: 'public-profile', identifier: 'alex' },
        { name: 'public-profile', identifier: 'alex' },
      ),
    ).toBe(true);
    expect(
      isSameRoute(
        { name: 'public-profile', identifier: 'alex' },
        { name: 'public-profile', identifier: 'bob' },
      ),
    ).toBe(false);
  });
});
