import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';

process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.AUTH_ORIGIN = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'auth-email-regression-test-secret';
process.env.TELEGRAM_BOT_TOKEN = 'test_token';
process.env.TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN = 'telegram.local.invalid';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `auth_email_${randomUUID().replaceAll('-', '')}`;
let admin;
if (testUrl) {
  admin = new Pool({ connectionString: testUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(testUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
}
const { getAuth, closeAuthResources } = await import('../dist/auth.js');
const { ensureAuthDatabaseSchema, getAuthPool } = await import('../dist/auth-meta.js');
const { closeDatabasePool } = await import('../dist/database.js');
const payload = { email: 'person@example.test', password: 'test-password-long', name: 'Test', username: 'testperson' };
function telegram(id) {
  const data = { id: String(id), first_name: 'Telegram', auth_date: String(Math.floor(Date.now() / 1000)) };
  const signed = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const hash = createHmac('sha256', createHash('sha256').update('test_token').digest()).update(signed).digest('hex');
  return new URLSearchParams({ ...data, hash }).toString();
}
async function post(path, body, token) {
  return getAuth().handler(new Request(`http://localhost:3000/api/auth${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
}
test('PostgreSQL: real auth endpoints reserve technical emails and never join by email', { skip: !testUrl }, async (t) => {
  try {
    await ensureAuthDatabaseSchema();
    const pool = getAuthPool();
    await t.test('custom and standard signup reject reserved domain, including case and whitespace', async () => {
      for (const endpoint of ['/register/email', '/sign-up/email']) {
        for (const email of ['telegram-123@telegram.local.invalid', '  TELEGRAM-123@TELEGRAM.LOCAL.INVALID  ']) {
          const response = await post(endpoint, { ...payload, email });
          assert.equal(response.status, 400, await response.text());
        }
      }
      assert.equal((await pool.query('SELECT id FROM "user"')).rowCount, 0);
    });
    const registered = await post('/register/email', payload);
    assert.equal(registered.status, 200, await registered.clone().text());
    const user = (await registered.json()).user;
    const token = (await pool.query('SELECT token FROM session WHERE user_id = $1', [user.id])).rows[0].token;
    await t.test('migration and standard email mutations reject reserved domain', async () => {
      for (const [path, body] of [
        ['/migration/complete', { ...payload, email: 'telegram-123@telegram.local.invalid' }],
        ['/change-email', { newEmail: 'telegram-123@telegram.local.invalid' }],
        ['/update-user', { email: 'telegram-123@telegram.local.invalid' }],
      ]) {
        const response = await post(path, body, token);
        assert.equal(response.status, 400, await response.text());
      }
      assert.equal((await pool.query('SELECT email FROM "user" WHERE id = $1', [user.id])).rows[0].email, payload.email);
    });
    await t.test('legacy occupied email yields conflict without sessions, bindings or data changes', async () => {
      await pool.query('UPDATE "user" SET email = $1 WHERE id = $2', ['telegram-123@telegram.local.invalid', user.id]);
      const before = (await pool.query('SELECT * FROM "user" WHERE id = $1', [user.id])).rows;
      const response = await post('/telegram/sign-in', { initData: telegram(123) });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'TELEGRAM_IDENTITY_CONFLICT');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual((await pool.query('SELECT * FROM "user" WHERE id = $1', [user.id])).rows, before);
      assert.equal((await pool.query("SELECT id FROM account WHERE provider_id = 'telegram'")).rowCount, 0);
      const login = await post('/sign-in/email', { email: 'telegram-123@telegram.local.invalid', password: payload.password });
      assert.equal(login.status, 200, await login.text());
    });
    await t.test('legacy owner can complete migration and explicitly prove Telegram ownership', async () => {
      const migration = await post('/migration/complete', payload, token);
      assert.equal(migration.status, 200, await migration.text());
      const link = await post('/telegram/link', { initData: telegram(123) }, token);
      assert.equal(link.status, 200, await link.text());
      const login = await post('/telegram/sign-in', { initData: telegram(123) });
      assert.equal(login.status, 200, await login.clone().text());
      assert.equal((await login.json()).user.id, user.id);
    });
    await t.test('concurrent first Telegram logins converge on a verified provider binding', async () => {
      const responses = await Promise.all([post('/telegram/sign-in', { initData: telegram(789) }), post('/telegram/sign-in', { initData: telegram(789) })]);
      const ids = [];
      for (const response of responses) {
        assert.equal(response.status, 200, await response.clone().text());
        ids.push((await response.json()).user.id);
      }
      assert.equal(ids[0], ids[1]);
      assert.equal((await pool.query("SELECT id FROM account WHERE provider_id = 'telegram' AND account_id = '789'")).rowCount, 1);
    });
    await t.test('new and repeat Telegram sign-in use provider binding even after changing email', async () => {
      const first = await post('/telegram/sign-in', { initData: telegram(456) });
      assert.equal(first.status, 200, await first.clone().text());
      const id = (await first.json()).user.id;
      assert.notEqual(id, user.id);
      await pool.query('UPDATE "user" SET email = $1 WHERE id = $2', ['telegram-owner@example.test', id]);
      const repeat = await post('/telegram/sign-in', { initData: telegram(456) });
      assert.equal(repeat.status, 200, await repeat.clone().text());
      assert.equal((await repeat.json()).user.id, id);
      assert.equal((await pool.query("SELECT user_id FROM account WHERE provider_id = 'telegram' AND account_id = '456'")).rows[0].user_id, id);
    });
  } finally {
    await closeAuthResources();
    await closeDatabasePool();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
