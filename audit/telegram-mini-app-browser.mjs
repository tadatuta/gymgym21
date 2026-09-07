// Synthetic A17 browser test. Fresh browser context, isolated Vite, no user env or Telegram credentials.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const envDir = await mkdtemp(join(tmpdir(), 'gym21-a17-env-'));
const server = await createServer({ root: resolve('apps/client'), configFile: false, envDir,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { entries: [], include: ['dexie', 'better-auth/client', '@better-auth/passkey/client'] },
  plugins: [{ name: 'synthetic-page', configureServer(s) { s.middlewares.use('/a17-test', (_req, res) => {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>A17 fixture</title><div id="fixture"></div>');
  }); } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const user = { id: 'fixture-tma', email: 'fixture@example.invalid', name: 'Fixture', username: 'fixture' };
  let exchanges = 0;
  let cookieRestores = 0;
  await page.route('https://telegram.org/**', route => route.fulfill({ contentType: 'application/javascript', body:
    route.request().url().includes('telegram-web-app.js')
      ? 'window.Telegram = {WebApp: {initData: "auth_date=123&hash=synthetic", ready() { window.fixtureReady = true; }}};' : '' }));
  await page.route('**/api/auth/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = null;
    const headers = { 'Content-Type': 'application/json' };
    if (url.pathname.endsWith('/telegram/sign-in')) {
      assert.deepEqual(request.postDataJSON(), { initData: 'auth_date=123&hash=synthetic' });
      exchanges++;
      headers['Set-Cookie'] = 'gym21_fixture=session; Path=/; HttpOnly; SameSite=Lax';
      body = { user };
    } else if (url.pathname.endsWith('/get-session')) {
      if ((await request.allHeaders()).cookie?.includes('gym21_fixture=session')) {
        cookieRestores++;
        body = { user, session: { id: 'fixture', userId: user.id, expiresAt: '2099-01-01T00:00:00Z' } };
      }
    } else if (url.pathname.endsWith('/migration/status')) {
      body = { user, storageKey: 'fixture-storage', needsCompletion: true, emailIsPlaceholder: true };
    } else if (url.pathname.endsWith('/sign-out')) {
      headers['Set-Cookie'] = 'gym21_fixture=; Path=/; Max-Age=0';
      body = { success: true };
    } else throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
    await route.fulfill({ headers, body: JSON.stringify(body) });
  });
  await page.goto(`${server.resolvedUrls.local[0]}a17-test`);
  await page.evaluate(async () => {
    const { renderLogin } = await import('/src/components/auth/Login.ts');
    await renderLogin(document.getElementById('fixture'), () => { throw new Error('Migration required'); });
  });
  assert.equal(await page.locator('#migration-complete-form').count(), 1);
  assert.equal(exchanges, 1);
  assert.ok(cookieRestores >= 1);
  assert.equal(await page.evaluate(() => window.fixtureReady), true);
  assert.ok((await page.context().cookies()).some(cookie => cookie.name === 'gym21_fixture' && cookie.httpOnly));
  await page.evaluate(async () => { await (await import('/src/auth.ts')).signOut(); });
  await page.reload();
  await page.evaluate(async () => {
    await (await import('/src/components/auth/Login.ts')).renderLogin(document.getElementById('fixture'), () => {});
  });
  assert.equal(await page.locator('#email-auth-form').count(), 1);
  assert.equal(exchanges, 1);
  await page.locator('#telegram-mini-app-sign-in').click();
  await page.locator('#migration-complete-form').waitFor();
  assert.equal(exchanges, 2);
  console.log('A17 Chromium: async SDK ready → raw initData exchange → real HttpOnly cookie restore → migration; logout/reload suppresses auto-login; explicit retry works.');
} finally {
  await browser?.close();
  await server.close();
  await rm(envDir, { recursive: true, force: true });
}
