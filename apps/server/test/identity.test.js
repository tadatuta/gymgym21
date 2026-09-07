import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';

process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.BETTER_AUTH_SECRET = 'identity-regression-test-secret';
process.env.RATE_LIMITS_ENABLED = 'false';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `identity_test_${randomUUID().replaceAll('-', '')}`;
let admin;
if (testUrl) {
  admin = new Pool({ connectionString: testUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(testUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
}
const { normalizeProfileForWrite, defaultStorageRepository: repository } = await import('../dist/storage.js');
const { AuthMetaService, ensureAuthDatabaseSchema, getAuthPool } = await import('../dist/auth-meta.js');
const { upsertAliasTx, resolveRequestContext, closeAuthResources } = await import('../dist/auth.js');
const { ensureDatabaseReady, closeDatabasePool } = await import('../dist/database.js');
const { createApp } = await import('../dist/app.js');
const profile = { id: 'me', isPublic: true, createdAt: '2026-09-01T00:00:00.000Z', username: 'victim', telegramUsername: 'victim', telegramUserId: 999 };

test('sync identity ignores supplied and stale identity for cookie and Telegram contexts', () => {
  for (const context of [
    { kind: 'better-auth', storageKey: 'cookie', authUser: { username: null } },
    { kind: 'telegram', storageKey: 'telegram_123', telegramUser: { id: 123, first_name: 'Test' } },
  ]) {
    const result = normalizeProfileForWrite(profile, { existing: profile, authContext: context });
    assert.equal(result.username, undefined);
    assert.equal(result.telegramUsername, undefined);
    assert.equal(result.telegramUserId, context.telegramUser?.id);
  }
  const result = normalizeProfileForWrite(profile, { authContext: {
    kind: 'better-auth', storageKey: 'linked', authUser: { username: 'real' },
    telegramUser: { id: 123, first_name: 'Test', username: 'real' },
  } });
  assert.equal(result.username, 'real');
  assert.equal(result.telegramUsername, 'real');
  assert.equal(result.telegramUserId, 123);
});

test('PostgreSQL: HTTP sync and concurrent alias writers preserve identity ownership', { skip: !testUrl }, async (t) => {
  try {
    await ensureAuthDatabaseSchema();
    await ensureDatabaseReady();
    const pool = getAuthPool();
    for (const id of ['victim-user', 'attacker-user']) {
      await pool.query('INSERT INTO "user" (id, name, email) VALUES ($1, $1, $2)', [id, `${id}@example.test`]);
      await AuthMetaService.ensureStorageBinding(id, () => id);
    }
    await AuthMetaService.claimAlias('victim-user', 'victim', 'canonical');
    await repository.updateProfileFromAuth('victim-user', { username: 'victim' });
    await t.test('identity transaction sees own writes and rolls back every registry on unexpected failure', async () => {
      const { withIdentityTransaction } = await import('../dist/auth-meta.js');
      const identity = await import('../dist/auth-identity.js');
      await assert.rejects(withIdentityTransaction(async client => {
        await client.query('INSERT INTO "user" (id, name, email) VALUES ($1, $1, $2)', ['atomic-user', 'atomic@example.test']);
        await identity.ensureStorageBindingTx(client, 'atomic-user', 'atomic-storage');
        assert.equal(await identity.linkProviderAccountTx(client, 'atomic-user', 'atomic-provider', 'telegram'), true);
        assert.equal(await identity.getUserIdByProviderAccount(client, 'atomic-provider', 'telegram'), 'atomic-user');
        await identity.setCanonicalAliasTx(client, 'atomic-user', 'atomicname');
        assert.equal((await identity.getUserById(client, 'atomic-user')).username, 'atomicname');
        await client.query('SELECT s07_deliberately_missing_function()');
      }), /s07_deliberately_missing_function/);
      for (const [table, column, value] of [['user', 'id', 'atomic-user'], ['account', 'user_id', 'atomic-user'], ['user_alias', 'user_id', 'atomic-user'], ['user_storage_binding', 'user_id', 'atomic-user']]) {
        assert.equal((await pool.query(`SELECT 1 FROM "${table}" WHERE ${column} = $1`, [value])).rowCount, 0);
      }
      const outcomes = await Promise.all(['victim-user', 'attacker-user'].map(id => withIdentityTransaction(client => identity.linkProviderAccountTx(client, id, 'race-provider', 'test-provider'))));
      assert.deepEqual(outcomes.sort(), [false, true]);
      const bindingBefore = await pool.query("SELECT xmin::text FROM user_storage_binding WHERE user_id = 'victim-user'");
      assert.equal(await AuthMetaService.ensureStorageBinding('victim-user', () => 'changed-storage'), 'victim-user');
      assert.deepEqual((await pool.query("SELECT xmin::text FROM user_storage_binding WHERE user_id = 'victim-user'")).rows, bindingBefore.rows);
      await assert.rejects(withIdentityTransaction(client => upsertAliasTx(client, 'missing-user', 'unexpected', 'telegram_username')), /foreign key/);
    });
    await t.test('cookie identity comes from linked account even when Telegram username equals canonical', async () => {
      await pool.query("INSERT INTO account (id, account_id, provider_id, user_id, telegram_username) VALUES ('telegram-victim', '999', 'telegram', 'victim-user', 'victim')");
      await pool.query("UPDATE \"user\" SET username = 'victim' WHERE id = 'victim-user'");
      await pool.query("INSERT INTO session (id, token, expires_at, user_id) VALUES ('session-victim', 'test-session-token', NOW() + INTERVAL '1 hour', 'victim-user')");
      const headers = new Headers({ authorization: 'Bearer test-session-token' });
      const context = await resolveRequestContext(headers);
      assert.equal(context.kind, 'better-auth');
      assert.equal(context.authUser.username, 'victim');
      const linked = context.telegramUser;
      assert.equal(linked.id, 999);
      assert.equal(linked.username, 'victim');

      await pool.query("UPDATE account SET telegram_username = NULL WHERE id = 'telegram-victim'");
      assert.equal((await resolveRequestContext(headers)).telegramUser.username, undefined);
    });
    await t.test('changed cookie rejects A payload before push or AI; missing identity cannot bypass guard', async () => {
      const token = 'account-b-cookie-token';
      await pool.query("INSERT INTO session (id, token, expires_at, user_id) VALUES ('session-b', $1, NOW() + INTERVAL '1 hour', 'attacker-user')", [token]);
      const signature = createHmac('sha256', process.env.BETTER_AUTH_SECRET).update(token).digest('base64');
      const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
      assert.equal((await resolveRequestContext(new Headers({ cookie }))).storageKey, 'attacker-user');
      let aiCalls = 0;
      const app = createApp({ authHandler: async () => {}, resolveRequestContext,
        generateRecommendation: async () => { aiCalls += 1; return 'advice'; },
        findPublicProfile: async () => null, storageRepository: repository });
      const beforeA = await repository.readSnapshot('victim-user');
      const beforeB = await repository.readSnapshot('attacker-user');
      for (const expected of [undefined, 'victim-user']) {
        for (const route of ['storage/sync', 'ai/recommendations']) {
          let call = request(app).post(`/api/me/${route}`).set('Cookie', cookie);
          if (expected) call = call.set('X-Expected-Storage-Key', expected);
          await call.send(route === 'storage/sync' ? { cursor: 0, changes: { profile } } : { type: 'general' }).expect(409);
        }
      }
      assert.equal(aiCalls, 0);
      assert.deepEqual(await repository.readSnapshot('victim-user'), beforeA);
      assert.deepEqual(await repository.readSnapshot('attacker-user'), beforeB);
      await request(app).post('/api/me/storage/sync').set('Cookie', cookie)
        .set('X-Expected-Storage-Key', 'attacker-user').send({ cursor: 0, changes: {} }).expect(200);
    });
    await t.test('HTTP cookie sync cannot forge any identity or steal an existing public alias', async () => {
      const context = { kind: 'better-auth', storageKey: 'attacker-user', authUser: { id: 'attacker-user', username: null } };
      const app = createApp({ authHandler: async () => {}, resolveRequestContext: async () => context,
        generateRecommendation: async () => '', findPublicProfile: async () => null, storageRepository: repository });
      await request(app).post('/api/me/storage/sync').set('X-Expected-Storage-Key', 'attacker-user').send({ cursor: 0, changes: { profile } }).expect(200);
      const saved = (await repository.readSnapshot('attacker-user')).profile;
      assert.equal(saved.username, undefined);
      assert.equal(saved.telegramUsername, undefined);
      assert.equal(saved.telegramUserId, undefined);
      const owner = await pool.query('SELECT storage_key FROM public_profile_aliases WHERE alias_lower = $1', ['victim']);
      assert.equal(owner.rows[0].storage_key, 'victim-user');
    });
    await t.test('Telegram sync rejects forged username and removes stale Telegram username', async () => {
      await repository.sync('telegram_123', { cursor: 0, changes: { profile } }, {
        kind: 'telegram', storageKey: 'telegram_123', telegramUser: { id: 123, first_name: 'Test' },
      });
      const saved = (await repository.readSnapshot('telegram_123')).profile;
      assert.equal(saved.username, undefined);
      assert.equal(saved.telegramUsername, undefined);
      assert.equal(saved.telegramUserId, 123);
    });
    await t.test('public writer cannot publish a foreign auth alias even before it has a public row', async () => {
      await AuthMetaService.claimAlias('victim-user', 'reserved', 'telegram_username');
      await repository.updateProfileFromAuth('telegram_124', { telegramUser: { id: 124, first_name: 'Test', username: 'reserved' } });
      assert.equal((await pool.query("SELECT * FROM public_profile_aliases WHERE alias_lower = 'reserved'")).rowCount, 0);
    });
    await t.test('auth writer cannot take an existing public alias and own refresh remains permitted', async () => {
      await repository.updateProfileFromAuth('telegram_125', { telegramUser: { id: 125, first_name: 'Test', username: 'publiconly' } });
      await assert.rejects(AuthMetaService.claimAlias('attacker-user', 'publiconly', 'canonical'), /Alias already taken/);
      await repository.updateProfileFromAuth('victim-user', { username: 'victim' });
      await AuthMetaService.claimAlias('victim-user', 'victim', 'canonical');
      assert.equal((await pool.query("SELECT storage_key FROM public_profile_aliases WHERE alias_lower = 'victim'")).rows[0].storage_key, 'victim-user');
    });
    await t.test('concurrent auth claims in both entry points yield one owner', async () => {
      const claim = async (id) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await upsertAliasTx(client, id, 'racing', 'telegram_username');
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      };
      const results = await Promise.allSettled([claim('victim-user'), AuthMetaService.claimAlias('attacker-user', 'racing', 'telegram_username')]);
      assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
      const owner = (await pool.query("SELECT user_id FROM user_alias WHERE alias_lower = 'racing'")).rows[0].user_id;
      await assert.rejects(AuthMetaService.setCanonicalAlias(owner === 'victim-user' ? 'attacker-user' : 'victim-user', 'racing'));
      assert.equal((await pool.query("SELECT user_id FROM user_alias WHERE alias_lower = 'racing'")).rows[0].user_id, owner);
    });
    await t.test('concurrent public claims never reassign the winning storage', async () => {
      await Promise.all(['telegram_201', 'telegram_202'].map((key, index) => repository.updateProfileFromAuth(key, {
        telegramUser: { id: 201 + index, first_name: 'Test', username: 'publicrace' },
      })));
      const owner = (await pool.query("SELECT storage_key FROM public_profile_aliases WHERE alias_lower = 'publicrace'")).rows[0].storage_key;
      const other = owner === 'telegram_201' ? 'telegram_202' : 'telegram_201';
      await repository.updateProfileFromAuth(other, { telegramUser: { id: 203, first_name: 'Test', username: 'publicrace' } });
      assert.equal((await pool.query("SELECT storage_key FROM public_profile_aliases WHERE alias_lower = 'publicrace'")).rows[0].storage_key, owner);
    });
    await t.test('concurrent auth/public claims share one namespace', async () => {
      await Promise.allSettled([
        AuthMetaService.claimAlias('attacker-user', 'crossrace', 'telegram_username'),
        repository.updateProfileFromAuth('telegram_301', { telegramUser: { id: 301, first_name: 'Test', username: 'crossrace' } }),
      ]);
      const auth = await pool.query("SELECT * FROM user_alias WHERE alias_lower = 'crossrace'");
      const publicAlias = await pool.query("SELECT * FROM public_profile_aliases WHERE alias_lower = 'crossrace'");
      assert.equal(auth.rowCount + publicAlias.rowCount, 1);
    });
  } finally {
    await closeAuthResources();
    await closeDatabasePool();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
