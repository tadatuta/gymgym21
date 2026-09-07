import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('uses the installed BetterAuth SDK: HTTP 503 and network failure retain logout, HTTP 200 confirms it', async () => {
  vi.resetModules();
  localStorage.clear();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Unavailable' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const auth = await import('./auth');
  await auth.signOut();
  const marker = localStorage.getItem('gym21_pending_sign_out_v1');
  expect(marker).toBeTruthy();
  expect(fetchMock.mock.calls[0][0].toString()).toContain('/sign-out');
  fetchMock.mockRejectedValue(new TypeError('Network unavailable'));
  expect((await auth.restoreSessionState()).status).toBe('unavailable');
  expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBe(marker);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
  expect((await auth.restoreSessionState()).status).toBe('unauthenticated');
  expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBeNull();
});
