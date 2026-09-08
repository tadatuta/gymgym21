import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import request from 'supertest';

const testUrl = process.env.GYM21_TEST_DATABASE_URL;
process.env.AUTH_ORIGIN = 'http://localhost:3000';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'http-auth-fixture-secret-at-least-32-characters';
process.env.TELEGRAM_BOT_TOKEN = 'http-auth-fixture-token';
process.env.TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN = 'telegram.local.invalid';
process.env.RATE_LIMITS_ENABLED = 'false';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;

test('PostgreSQL: mounted auth HTTP endpoints preserve cookie and identity ownership', { skip: !testUrl }, async t => {
  const schema = `auth_http_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: testUrl });
  let closeAuthResources;
  let closeDatabasePool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(testUrl);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const auth = await import('../dist/auth.js');
    closeAuthResources = auth.closeAuthResources;
    ({ closeDatabasePool } = await import('../dist/database.js'));
    const { getAuthPool } = await import('../dist/auth-meta.js');
    const { defaultStorageRepository: repository } = await import('../dist/storage.js');
    const { createApp } = await import('../dist/app.js');
    await auth.ensureAuthReady();
    const pool = getAuthPool();
    const app = createApp({ authHandler: auth.createAuthNodeHandler(), resolveRequestContext: auth.resolveRequestContext,
      storageRepository: repository, findPublicProfile: async () => null,
      generateRecommendation: async () => { throw new Error('Unexpected AI request'); } });
    const post = (path, body, cookie) => request(app).post(`/api/auth${path}`).set('Origin', process.env.AUTH_ORIGIN)
      .set('Cookie', cookie || '').send(body).timeout(10000);
    const cookieFrom = response => {
      const values = response.headers['set-cookie'] || [];
      assert.ok(values.some(value => /session_token=.*HttpOnly/i.test(value)), 'real HttpOnly session cookie issued');
      return values.map(value => value.split(';')[0]).join('; ');
    };
    const getSession = cookie => request(app).get('/api/auth/get-session').set('Cookie', cookie);
    const payload = (email, username) => ({ email, username, password: 'synthetic-password-long', name: 'HTTP fixture' });
    const snapshotIdentity = async () => {
      const result = {};
      for (const [table, order] of [['user', 'id'], ['account', 'id'], ['session', 'id'], ['user_alias', 'alias_lower'], ['user_storage_binding', 'user_id']]) {
        result[table] = (await pool.query(`SELECT * FROM "${table}" ORDER BY ${order}`)).rows;
      }
      return result;
    };
    const telegram = (id, username) => {
      const data = { id: String(id), first_name: 'Synthetic', username, auth_date: String(Math.floor(Date.now() / 1000)) };
      const signed = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
      return new URLSearchParams({ ...data, hash: createHmac('sha256', createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN).digest()).update(signed).digest('hex') }).toString();
    };
    await t.test('reserved placeholder and invalid Telegram proof cannot write identity or issue cookies', async () => {
      const before = await snapshotIdentity();
      for (const endpoint of ['/register/email', '/sign-up/email']) {
        const response = await post(endpoint, payload(' TELEGRAM-91@TELEGRAM.LOCAL.INVALID ', 'reserved91'));
        assert.equal(response.status, 400);
        assert.equal(response.headers['set-cookie'], undefined);
      }
      const denied = await post('/telegram/sign-in', { initData: `${telegram(91, 'unverified91')}x` });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers['set-cookie'], undefined);
      assert.deepEqual(await snapshotIdentity(), before);
    });
    let owner;
    let ownerCookie;
    await t.test('concurrent email registrations sharing an alias create exactly one complete owner', async () => {
      // Stop both INSERTs after their availability reads. Without this barrier a
      // scheduler could let the second precheck see the winner and hide the race.
      const lockId = parseInt(randomUUID().slice(0, 7), 16);
      const blocker = await admin.connect();
      let calls = [];
      let responses;
      try {
        await blocker.query('SELECT pg_advisory_lock(2104, $1)', [lockId]);
        await pool.query(`CREATE FUNCTION wait_for_registration_race() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(2104, ${lockId}); RETURN NEW; END $$;
          CREATE TRIGGER wait_for_registration_race BEFORE INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION wait_for_registration_race()`);
        calls = ['race-a@example.test', 'race-b@example.test'].map(email => Promise.resolve(post('/register/email', payload(email, 'racingowner'))));
        const deadline = Date.now() + 5000;
        let waiting = 0;
        while (Date.now() < deadline) {
          waiting = Number((await admin.query('SELECT count(*) FROM pg_locks WHERE locktype = \'advisory\' AND classid = 2104 AND objid = $1 AND NOT granted', [lockId])).rows[0].count);
          if (waiting === 2) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(waiting, 2, 'both registration INSERTs reached SQL after prechecks');
        await blocker.query('SELECT pg_advisory_unlock(2104, $1)', [lockId]);
        responses = await Promise.all(calls);
      } finally {
        await blocker.query('SELECT pg_advisory_unlock_all()');
        blocker.release();
        await Promise.allSettled(calls);
        await pool.query('DROP TRIGGER IF EXISTS wait_for_registration_race ON "user"; DROP FUNCTION IF EXISTS wait_for_registration_race()');
      }
      assert.equal(responses.filter(response => response.status === 200).length, 1);
      const winner = responses.find(response => response.status === 200);
      const loser = responses.find(response => response.status !== 200);
      assert.equal(loser.status, 400, JSON.stringify(loser.body));
      assert.equal(loser.headers['set-cookie'], undefined);
      owner = winner.body.user;
      ownerCookie = cookieFrom(winner);
      assert.equal((await getSession(ownerCookie)).body.user.id, owner.id);
      assert.equal((await pool.query('SELECT id FROM "user"')).rowCount, 1);
      assert.equal((await pool.query('SELECT user_id FROM account')).rows[0].user_id, owner.id);
      assert.equal((await pool.query('SELECT user_id FROM user_alias')).rows[0].user_id, owner.id);
      assert.equal((await pool.query('SELECT user_id FROM user_storage_binding')).rows[0].user_id, owner.id);
      assert.equal((await pool.query('SELECT user_id FROM session')).rows[0].user_id, owner.id);
    });
    await t.test('concurrent registrations sharing email leave no orphan alias, credential, binding or session', async () => {
      const responses = await Promise.all(['emailracea', 'emailraceb'].map(username => post('/register/email', payload('race@example.test', username))));
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
      const winner = responses.find(response => response.status === 200);
      const loser = responses.find(response => response.status !== 200);
      assert.equal(loser.headers['set-cookie'], undefined);
      assert.equal((await getSession(cookieFrom(winner))).body.user.id, winner.body.user.id);
      const users = (await pool.query('SELECT id FROM "user"')).rows.map(row => row.id).sort();
      assert.equal(users.length, 2);
      for (const table of ['account', 'user_alias', 'user_storage_binding', 'session']) {
        assert.deepEqual((await pool.query(`SELECT user_id FROM ${table}`)).rows.map(row => row.user_id).sort(), users);
      }
    });
    await t.test('unexpected database error still returns 500 and rolls back registration', async () => {
      const before = await snapshotIdentity();
      await pool.query(`CREATE FUNCTION reject_registration() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic unexpected registration failure'; END $$;
        CREATE TRIGGER reject_registration BEFORE INSERT ON user_storage_binding FOR EACH ROW EXECUTE FUNCTION reject_registration()`);
      try {
        const response = await post('/register/email', payload('failure@example.test', 'failedowner')).expect(500);
        assert.equal(response.headers['set-cookie'], undefined);
        assert.deepEqual(await snapshotIdentity(), before);
      } finally {
        await pool.query('DROP TRIGGER reject_registration ON user_storage_binding; DROP FUNCTION reject_registration()');
      }
    });
    await t.test('verified Telegram link cannot be reassigned by another cookie account or invalid proof', async () => {
      const other = await post('/register/email', payload('other@example.test', 'otherowner')).expect(200);
      const otherCookie = cookieFrom(other);
      const proof = telegram(991122, 'linkedtelegram');
      const linked = await post('/telegram/link', { initData: proof }, ownerCookie).expect(200);
      assert.equal(linked.body.user.id, owner.id);
      const ownerStorage = linked.body.storageKey;
      const otherStorage = (await request(app).get('/api/auth/migration/status').set('Cookie', otherCookie).expect(200)).body.storageKey;
      const before = await snapshotIdentity();
      const dataBefore = await Promise.all([repository.readSnapshot(ownerStorage), repository.readSnapshot(otherStorage)]);
      await post('/telegram/link', { initData: proof }).expect(401);
      const conflict = await post('/telegram/link', { initData: proof }, otherCookie).expect(400);
      assert.equal(conflict.headers['set-cookie'], undefined);
      await post('/telegram/link', { initData: `${proof}x` }, otherCookie).expect(401);
      assert.deepEqual(await snapshotIdentity(), before);
      assert.deepEqual(await Promise.all([repository.readSnapshot(ownerStorage), repository.readSnapshot(otherStorage)]), dataBefore);
      assert.equal((await getSession(ownerCookie)).body.user.id, owner.id);
      assert.equal((await getSession(otherCookie)).body.user.id, other.body.user.id);
      const login = await post('/telegram/sign-in', { initData: proof }).expect(200);
      assert.equal(login.body.user.id, owner.id);
      assert.equal((await getSession(cookieFrom(login))).body.user.id, owner.id);
    });
  } finally {
    await closeAuthResources?.();
    await closeDatabasePool?.();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
