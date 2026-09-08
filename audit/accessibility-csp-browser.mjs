// O07: real CSP, official downloaded widgets; every remote request is intercepted.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, preview, createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const widget = await readFile(process.env.TELEGRAM_WIDGET_PATH || '/tmp/gym21-o07-telegram-widget.js', 'utf8');
const metrika = await readFile(process.env.METRIKA_SCRIPT_PATH || '/tmp/gym21-o07-metrika.js', 'utf8');
assert.ok(widget.includes('__parseFunction') && widget.includes('eval(__func)'));
const envDir = await mkdtemp(join(tmpdir(), 'gym21-o07-env-'));
const production = process.argv.includes('--production');
const outputDir = join(envDir, 'dist');
if (production) await writeFile(join(envDir, '.env'), 'VITE_AUTH_BASE_URL=https://auth.example.test/api/auth\nVITE_API_BASE_URL=https://api.example.test/api\n');
const config = { root: resolve('apps/client'), envDir,
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { entries: [], include: ['dexie', 'zod', 'better-auth/client', '@better-auth/passkey/client', 'sortablejs', 'dompurify', 'marked'] },
  build: { outDir: outputDir, emptyOutDir: true },
};
if (production) await build(config);
const server = production ? await preview(config) : await createServer(config);
let browser;
try {
  if (!production) await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  page.on('pageerror', error => console.log('Page error:', error.message));
  let authenticated = false;
  let exchanges = 0;
  let analyticsRequests = 0;
  const unexpected = [];
  const user = { id: 'o07-fixture', email: 'fixture@example.invalid', name: 'Fixture', username: 'fixture' };
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  });
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (!production && url.pathname === '/src/main.ts' && url.origin === origin) return route.fulfill({ contentType: 'application/javascript', body: `
      import '/src/styles/base.css'; import '/src/styles/components.css'; import '/src/styles/profile.css'; import '/src/styles/stats.css';
      import { renderLogin } from '/src/components/auth/Login.ts';
      await renderLogin(document.getElementById('app'), () => { window.loginSucceeded = true; });` });
    if ([origin, 'https://auth.example.test', 'https://api.example.test'].includes(url.origin) && url.pathname.startsWith('/api/')) {
      if (request.method() === 'OPTIONS') return route.fulfill({ headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }, body: '' });
      let body = null;
      if (url.pathname.endsWith('/telegram/sign-in')) {
        assert.equal(new URLSearchParams(request.postDataJSON().initData).get('id'), '12345');
        exchanges++; authenticated = true; body = { user };
      } else if (url.pathname.endsWith('/get-session')) {
        if (authenticated) body = { user, session: { id: 'fixture', userId: user.id, expiresAt: '2099-01-01T00:00:00Z' } };
      } else if (url.pathname.endsWith('/migration/status')) body = { user, storageKey: 'fixture', needsCompletion: production };
      else throw new Error(`Unexpected local API: ${url.pathname}`);
      return route.fulfill({ headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }, contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.hostname === 'telegram.org') return route.fulfill({ contentType: 'application/javascript', body: url.pathname.includes('telegram-widget') ? widget : 'window.Telegram = window.Telegram || {}; window.Telegram.WebApp = {initData:"",ready(){}};' });
    if (url.hostname === 'oauth.telegram.org') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><button id="login">Synthetic Telegram user</button><script>document.getElementById("login").onclick=()=>parent.postMessage(JSON.stringify({event:"auth_user",auth_data:{id:12345,first_name:"Fixture",auth_date:123,hash:"synthetic"}}),"'+origin+'");</script>' });
    if (['mc.yandex.ru', 'mc.yandex.com', 'yastatic.net'].includes(url.hostname)) {
      if (url.pathname === '/metrika/tag.js') return route.fulfill({ contentType: 'application/javascript', body: metrika });
      analyticsRequests++;
      return route.fulfill({ headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }, contentType: 'application/json', body: '{}' });
    }
    if (url.origin === origin) return route.continue();
    unexpected.push(url.origin); return route.abort();
  });
  await page.goto(origin);
  await page.locator('#auth-email').waitFor();
  assert.equal(await page.locator('meta[name="viewport"]').getAttribute('content'), 'width=device-width, initial-scale=1.0');
  await page.getByText('Email', { exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'auth-email');
  await page.getByRole('button', { name: 'Регистрация', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('fixture');
  assert.equal(await page.getByLabel('Пароль', { exact: true }).getAttribute('autocomplete'), 'new-password');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(tmpdir(), `gym21-o07-auth-${production ? 'production' : 'dev'}.png`) });
  await page.frameLocator('iframe[id^="telegram-login-"]').getByRole('button').click();
  if (production) await page.locator('#migration-complete-form').waitFor();
  else await page.waitForFunction(() => window.loginSucceeded === true);
  assert.equal(exchanges, 1);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  if (production) {
    assert.ok(policy.includes('https://auth.example.test https://api.example.test'));
    assert.ok(!policy.includes('ws://'));
  } else assert.ok(policy.includes(origin.replace('http:', 'ws:')));
  await page.waitForFunction(() => typeof window.ym === 'function');
  await page.evaluate(() => window.ym(106707570, 'hit', location.href + '?synthetic=1'));
  await page.waitForTimeout(5000);
  assert.ok(analyticsRequests > 0, 'Official analytics must attempt collection (intercepted, never sent)');
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(unexpected, []);
  // Page-evaluate itself bypasses CSP; fetch invoked by it still obeys connect-src.
  assert.equal(await page.evaluate(() => fetch('https://blocked.example.invalid/probe').then(() => false, () => true)), true);
  await page.waitForFunction(() => window.cspViolations.some(v => v.directive === 'connect-src'));
  // The official widget above proves why unsafe-eval remains: its actual data-onauth parser executes.
  console.log('O07 CSP: official Telegram callback → synthetic auth/session → success; official Metrika collection intercepted; forbidden origin blocked; 320/390px auth labels and layout passed.');
} finally { await browser?.close(); if (production) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); else await server.close(); await rm(envDir, { recursive: true, force: true }); }
