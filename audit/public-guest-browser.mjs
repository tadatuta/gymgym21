// A18: actual main.ts with synthetic public/auth endpoints and no user environment.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
const envDir = await mkdtemp(join(tmpdir(), 'gym21-a18-env-'));
const server = await createServer({ root: resolve('apps/client'), configFile: false, envDir,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'synthetic-pwa', resolveId(id) { if (id === 'virtual:pwa-register') return '\0synthetic-pwa'; },
    load(id) { if (id === '\0synthetic-pwa') return 'export const registerSW = () => {};'; },
    configureServer(s) { s.middlewares.use((req, res, next) => {
      if (!req.headers.accept?.includes('text/html')) return next();
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><div id="app"></div><script type="module" src="/src/main.ts"></script>');
    }); } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let authUnavailable = false;
  let authenticated = false;
  let activationCalls = 0;
  let releaseActivation;
  const user = { id: 'synthetic', name: 'Synthetic', email: 'synthetic@example.invalid' };
  let releaseSlow;
  const profile = name => ({ identifier: name, displayName: name, stats: { totalWorkouts: 0, totalVolume: 0 }, recentActivity: [], logs: [], workoutTypes: [] });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!url.hostname.match(/^(127\.0\.0\.1|localhost)$/)) return route.fulfill({ body: '' });
    if (url.pathname.includes('/api/auth/')) {
      const body = !authenticated ? null : url.pathname.endsWith('/migration/status')
        ? { user, storageKey: 'synthetic', needsCompletion: false, hasPassword: true }
        : { user, session: { id: 'synthetic', userId: user.id, expiresAt: '2099-01-01T00:00:00Z' } };
      return route.fulfill({ status: authUnavailable ? 503 : 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.pathname.includes('/api/me/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ cursor: 0, changes: {}, conflicts: [], hasMore: false }) });
    if (url.pathname.includes('/api/profiles/')) {
      const name = url.pathname.split('/').at(-1);
      if (name === 'activation' && ++activationCalls === 1) await new Promise(resolve => { releaseActivation = resolve; });
      if (name === 'slow') await new Promise(resolve => { releaseSlow = resolve; });
      const status = name === 'private' ? 403 : name === 'missing' ? 404 : name === 'error' ? 503 : 200;
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(profile(name)) });
    }
    return route.continue();
  });
  const base = server.resolvedUrls.local[0];
  await page.goto(`${base}profile/public`);
  await page.getByText('public', { exact: true }).waitFor();
  assert.equal(await page.locator('#friend-action-btn, .navigation').count(), 0);
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name)), []);
  await page.locator('#guest-sign-in').click();
  await page.locator('#email-auth-form').waitFor();
  await page.locator('#guest-profile-back').click();
  await page.getByText('public', { exact: true }).waitFor();
  await page.locator('#guest-sign-in').click();
  await page.locator('#email-auth-form').waitFor();
  await page.goBack();
  await page.getByText('public', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('public', { exact: true }).waitFor();
  assert.ok(page.url().endsWith('/profile/public'));
  for (const name of ['private', 'missing']) {
    await page.goto(`${base}profile/${name}`);
    await page.getByText('Профиль скрыт или не существует').waitFor();
    await page.locator('#guest-sign-in').waitFor();
  }
  await page.goto(`${base}profile/error`);
  await page.locator('#public-profile-retry').waitFor();
  await page.locator('#public-profile-retry').click();
  await page.locator('#public-profile-retry').waitFor();
  authUnavailable = true;
  await page.goto(`${base}?startapp=profile_available`);
  await page.getByText('available', { exact: true }).waitFor();
  assert.ok(page.url().endsWith('/profile/available'));
  await page.evaluate(() => { history.pushState(null, '', '/profile/slow'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByText('Загрузка профиля...').waitFor();
  await page.locator('#guest-sign-in').click();
  await page.locator('#email-auth-form').waitFor();
  await page.locator('input[type=email]').fill('draft@example.invalid');
  releaseSlow();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('input[type=email]').inputValue(), 'draft@example.invalid');
  await page.locator('#guest-profile-back').click();
  await page.getByText('slow', { exact: true }).waitFor();
  await page.evaluate(() => { history.pushState(null, '', '/profile/latest'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByText('latest', { exact: true }).waitFor();
  await page.evaluate(() => { history.pushState(null, '', '/profile/slow'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByText('Загрузка профиля...').waitFor();
  await page.evaluate(() => { history.pushState(null, '', '/profile/latest'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByText('latest', { exact: true }).waitFor();
  releaseSlow();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.getByText('slow', { exact: true }).count(), 0);
  authenticated = true;
  authUnavailable = false;
  await page.goto(`${base}profile/activation`);
  await page.locator('#friend-action-btn').waitFor();
  assert.ok(activationCalls >= 2);
  releaseActivation();
  await page.waitForLoadState('networkidle');
  await page.getByText('activation', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('activation', { exact: true }).waitFor();
  assert.ok(page.url().endsWith('/profile/activation'));
  assert.deepEqual(errors, []);
  console.log('A18 Chromium: actual main guest public/403/404/503, no IndexedDB/mutations, signin/back/reload, auth unavailable/deeplink and stale route response passed.');
} finally {
  await browser?.close();
  await server.close();
  await rm(envDir, { recursive: true, force: true });
}
