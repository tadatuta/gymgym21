// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const user = { id: 'telegram-user', email: 'telegram@fixture.invalid', name: 'Fixture', username: 'fixture', emailVerified: false };
const session = { user, session: { id: 'fixture-session', userId: user.id, expiresAt: '2099-01-01T00:00:00Z' } };
let signedIn = false;
let rejectTelegram = false;
let needsCompletion = false;
let fetchMock: ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>>;
let container: HTMLElement;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const telegramCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/telegram/sign-in'));
const sdk = (initData = 'auth_date=123&hash=synthetic') => {
  const app = { initData, ready: vi.fn() };
  window.Telegram = { WebApp: app };
  return app;
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('BroadcastChannel', undefined);
  delete window.Telegram;
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="fixture"></div>';
  container = document.getElementById('fixture')!;
  signedIn = rejectTelegram = needsCompletion = false;
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/telegram/sign-in')) {
      if (rejectTelegram) return json({ message: 'Expired initData' }, 401);
      signedIn = true;
      return json({ user });
    }
    if (url.includes('/get-session')) return json(signedIn ? session : null);
    if (url.endsWith('/migration/status')) return json({ user, storageKey: 'fixture-storage', needsCompletion, emailIsPlaceholder: true });
    if (url.endsWith('/sign-out')) { signedIn = false; return json({ success: true }); }
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('exchanges raw SDK initData using installed BetterAuth session transport and opens migration', async () => {
  const app = sdk();
  needsCompletion = true;
  const { renderLogin } = await import('./components/auth/Login');
  const done = vi.fn();
  await renderLogin(container, done);
  expect(app.ready).toHaveBeenCalled();
  expect(telegramCalls()).toHaveLength(1);
  expect(telegramCalls()[0][1]).toMatchObject({ credentials: 'include', body: JSON.stringify({ initData: app.initData }) });
  expect((await import('./auth')).getCurrentSession()?.user.id).toBe(user.id);
  expect(container.querySelector('#migration-complete-form')).toBeTruthy();
  expect(done).not.toHaveBeenCalled();
});

it('preserves restored cookie session and never exchanges launch identity', async () => {
  sdk(); signedIn = true;
  const done = vi.fn();
  await (await import('./components/auth/Login')).renderLogin(container, done);
  expect(done).toHaveBeenCalledOnce();
  expect(telegramCalls()).toHaveLength(0);
});

it('keeps Web/PWA login with empty initData', async () => {
  sdk('');
  await (await import('./components/auth/Login')).renderLogin(container, vi.fn());
  expect(container.querySelector('#email-auth-form')).toBeTruthy();
  expect(telegramCalls()).toHaveLength(0);
});

it('bounds a missing SDK, shares pending load and retries a failed load only explicitly', async () => {
  vi.useFakeTimers();
  const { loadTelegramWebApp } = await import('./services/telegram-mini-app');
  const first = loadTelegramWebApp();
  expect(loadTelegramWebApp(true)).toBe(first);
  expect(document.head.querySelectorAll('script')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4000);
  expect(await first).toBeNull();
  expect(await loadTelegramWebApp()).toBeNull();
  expect(document.head.querySelectorAll('script')).toHaveLength(0);
  const second = loadTelegramWebApp(true);
  document.head.querySelector('script')!.dispatchEvent(new Event('error'));
  expect(await second).toBeNull();
  sdk().ready.mockImplementation(() => { throw new Error('bridge unavailable'); });
  expect(await loadTelegramWebApp(true)).toBeNull();
});

it('renders fallback before SDK completes and ignores late SDK after input or replacement', async () => {
  const { renderLogin } = await import('./components/auth/Login');
  const pending = renderLogin(container, vi.fn());
  await vi.waitFor(() => expect(container.querySelector('#email-auth-form')).toBeTruthy());
  container.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
  sdk(); document.head.querySelector('script')!.dispatchEvent(new Event('load'));
  await pending;
  expect(telegramCalls()).toHaveLength(0);
});

it('coalesces concurrent login renders, only latest completes', async () => {
  const { renderLogin } = await import('./components/auth/Login');
  const old = vi.fn(); const latest = vi.fn();
  const one = renderLogin(container, old);
  const two = renderLogin(container, latest);
  await vi.waitFor(() => expect(document.head.querySelector('script')).toBeTruthy());
  sdk(); document.head.querySelector('script')!.dispatchEvent(new Event('load'));
  await Promise.all([one, two]);
  expect(telegramCalls()).toHaveLength(1);
  expect(old).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
});

it('does not retry expired initData on rerender; explicit button retries', async () => {
  sdk(); rejectTelegram = true;
  const { renderLogin } = await import('./components/auth/Login');
  await renderLogin(container, vi.fn());
  expect(container.textContent).toContain('Expired initData');
  await renderLogin(container, vi.fn());
  expect(telegramCalls()).toHaveLength(1);
  rejectTelegram = false;
  container.querySelector<HTMLButtonElement>('#telegram-mini-app-sign-in')!.click();
  await vi.waitFor(() => expect(telegramCalls()).toHaveLength(2));
});

it('logout suppresses late SDK and persists suppression after reload and successful pending logout', async () => {
  const { renderLogin } = await import('./components/auth/Login');
  const pending = renderLogin(container, vi.fn());
  await vi.waitFor(() => expect(document.head.querySelector('script')).toBeTruthy());
  const auth = await import('./auth');
  await auth.signOut();
  sdk(); document.head.querySelector('script')!.dispatchEvent(new Event('load'));
  await pending;
  expect(telegramCalls()).toHaveLength(0);
  expect(auth.canAutoSignInWithTelegram()).toBe(false);
  vi.resetModules();
  await (await import('./components/auth/Login')).renderLogin(container, vi.fn());
  expect(telegramCalls()).toHaveLength(0);
  expect(container.querySelector('#telegram-mini-app-sign-in')).toBeTruthy();
});

it('preserves an offline account from launch even after its selection is cleared', async () => {
  localStorage.setItem('gym21_offline_accounts_v1', JSON.stringify({
    version: 1, activeStorageKey: 'saved', accounts: {
      saved: { user, storageKey: 'saved', migrationStatus: { user, storageKey: 'saved' }, lastValidatedAt: new Date().toISOString() },
    },
  }));
  sdk();
  const auth = await import('./auth');
  expect(auth.getOfflineAccount()?.storageKey).toBe('saved');
  await (await import('./components/auth/Login')).renderLogin(container, vi.fn());
  expect(auth.getOfflineAccount()?.storageKey).toBe('saved');
  auth.clearAuthState();
  expect(auth.canAutoSignInWithTelegram()).toBe(false);
  expect(telegramCalls()).toHaveLength(0);
});

it('pending logout at launch remains an auto-login barrier after network recovery', async () => {
  localStorage.setItem('gym21_pending_sign_out_v1', 'synthetic-logout-intent');
  sdk();
  const auth = await import('./auth');
  const { renderLogin } = await import('./components/auth/Login');
  fetchMock.mockResolvedValueOnce(json({ message: 'Unavailable' }, 503));
  await renderLogin(container, vi.fn());
  expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBeTruthy();
  await renderLogin(container, vi.fn());
  expect(localStorage.getItem('gym21_pending_sign_out_v1')).toBeNull();
  expect(auth.canAutoSignInWithTelegram()).toBe(false);
  expect(telegramCalls()).toHaveLength(0);
  container.querySelector<HTMLButtonElement>('#telegram-mini-app-sign-in')!.click();
  await vi.waitFor(() => expect(telegramCalls()).toHaveLength(1));
});

it('logout cancels a pending cookie exchange before finalization and then clears its cookie', async () => {
  sdk();
  let release!: (response: Response) => void;
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((input: unknown) => String(input).endsWith('/telegram/sign-in')
    ? new Promise<Response>((resolve) => { release = resolve; }) : original(input));
  const done = vi.fn();
  const pending = (await import('./components/auth/Login')).renderLogin(container, done);
  await vi.waitFor(() => expect(telegramCalls()).toHaveLength(1));
  const auth = await import('./auth');
  const logout = auth.signOut();
  signedIn = true;
  release(json({ user }));
  await Promise.all([pending, logout]);
  expect(done).not.toHaveBeenCalled();
  expect(signedIn).toBe(false);
  expect(auth.getCurrentSession()).toBeNull();
});

it('ignores delayed session restore after auth invalidation and main replaces the view', async () => {
  let release!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  const pending = (await import('./components/auth/Login')).renderLogin(container, vi.fn());
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  (await import('./auth')).clearAuthState();
  container.innerHTML = '<div>New account view</div>';
  release(json(null));
  await pending;
  expect(container.textContent).toBe('New account view');
  expect(telegramCalls()).toHaveLength(0);
});

it('disposal on main takeover prevents a stale auto-login error replacing the new account view', async () => {
  sdk();
  let release!: (response: Response) => void;
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((input: unknown) => String(input).endsWith('/telegram/sign-in')
    ? new Promise<Response>((resolve) => { release = resolve; }) : original(input));
  const { renderLogin, disposeLogin } = await import('./components/auth/Login');
  const done = vi.fn();
  const pending = renderLogin(container, done);
  await vi.waitFor(() => expect(telegramCalls()).toHaveLength(1));
  (await import('./auth')).clearAuthState();
  disposeLogin(container);
  container.innerHTML = '<div>New account main view</div>';
  release(json({ user }));
  await pending;
  expect(container.textContent).toBe('New account main view');
  expect(done).not.toHaveBeenCalled();
});
