import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { createServer as createTcpServer, connect } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import dns from 'node:dns';
import { once } from 'node:events';
import { test } from 'node:test';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';

const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `runtime_${randomUUID().replaceAll('-', '')}`;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
process.env.BETTER_AUTH_SECRET = 'runtime-synthetic-secret-only-12345678';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
const scoped = testUrl ? new URL(testUrl) : null;
if (scoped) { scoped.searchParams.set('options', `-csearch_path=${schema}`); process.env.DATABASE_URL = scoped.toString(); }
const { config } = await import('../dist/config.js');
const db = await import('../dist/database.js');
const { startServer, stopServer } = await import('../dist/server.js');
const { PostgresRateLimitStore, createMemoryRateLimitStore } = await import('../dist/http/middleware/rate-limit-store.js');
const { createRateLimitMiddleware, holdRateLimitUntil, rateLimitStoreReady } = await import('../dist/http/middleware/rate-limit.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label) {
  const deadline = Date.now() + 5000;
  while (!await check()) { assert(Date.now() < deadline, label); await pause(20); }
}

function child(env) {
  const process = fork(new URL('./fixtures/rate-limit-process.mjs', import.meta.url), { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  for (const stream of [process.stdout, process.stderr]) stream.on('data', chunk => { output += chunk; });
  const messages = [];
  process.on('message', message => messages.push(message));
  return { process, messages, output: () => output };
}

test('PostgreSQL runtime deadlines, readiness, shared windows and renewable operation leases', { skip: !testUrl, timeout: 60000 }, async t => {
  const saved = { ...config };
  const admin = new Pool({ connectionString: testUrl });
  const children = [];
  let server;
  let proxy;
  const sockets = new Set();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    Object.assign(config, { DB_CONNECT_TIMEOUT_MS: 1500, DB_QUERY_TIMEOUT_MS: 1000, DB_STATEMENT_TIMEOUT_MS: 300, READINESS_TIMEOUT_MS: 300, SHUTDOWN_TIMEOUT_MS: 200, STARTUP_TIMEOUT_MS: 2000, RATE_LIMIT_STORE_TIMEOUT_MS: 1000, PORT: 0, HOST: '127.0.0.1' });
    await t.test('migration state, bounded statement and exhausted-pool probe, late checkout cleanup', async () => {
      assert.equal(await db.checkDatabaseReadiness(), false);
      await db.ensureDatabaseReady();
      assert.equal(await db.checkDatabaseReadiness(), true);
      const began = Date.now();
      await assert.rejects(db.getDatabasePool().query('SELECT pg_sleep(5)'), { code: '57014' });
      assert(Date.now() - began < 1500);
      const clients = await Promise.all(Array.from({ length: 10 }, () => db.getDatabasePool().connect()));
      const probe = db.checkDatabaseReadiness();
      assert.equal(await probe, false);
      clients.forEach(client => client.release());
      await eventually(() => db.getDatabasePool().waitingCount === 0, 'late readiness checkout drained');
      assert.equal(await db.checkDatabaseReadiness(), true);
    });
    await t.test('held pool clients and active queries close within deadline; clean reopening', async () => {
      const old = db.getDatabasePool();
      const store = new PostgresRateLimitStore();
      const admission = await store.acquire({ key: 'shutdown-lease', windowMs: 1000, maxRequests: 10, maxConcurrent: 1 });
      const held = await old.connect();
      const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const operation = held.query('SELECT pg_sleep(5)').catch(() => {});
      const began = Date.now();
      await Promise.all([db.closeDatabasePool(), db.closeDatabasePool()]);
      assert(Date.now() - began < 1500);
      await operation;
      await assert.rejects(store.renew(admission.lease), /Cannot use a pool after calling end/);
      await assert.rejects(store.release(admission.lease), /Cannot use a pool after calling end/);
      held.release(true);
      await eventually(async () => (await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].n === 0, 'old backend closed');
      assert.equal(await db.checkDatabaseReadiness(), false);
      await db.ensureDatabaseReady();
      assert.notEqual(db.getDatabasePool(), old);
      await db.getDatabasePool().query('DELETE FROM rate_limit_leases WHERE id=$1', [admission.lease]);
      assert.equal(await db.checkDatabaseReadiness(), true);
    });
    await t.test('failed bind cleans resources and handlers; restart and stalled HTTP shutdown', async () => {
      const blocker = createHttpServer();
      await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
      config.PORT = blocker.address().port;
      const listeners = process.listenerCount('SIGTERM');
      try { await assert.rejects(startServer(), { code: 'EADDRINUSE' }); }
      finally { await new Promise(resolve => blocker.close(resolve)); }
      assert.equal(process.listenerCount('SIGTERM'), listeners);
      assert.equal(await db.checkDatabaseReadiness(), false);
      config.PORT = 0;
      server = await startServer();
      await request(server).get('/ready').expect(200, { ok: true });
      await request(server).get('/health').expect(200, { ok: true });
      const socket = connect(server.address().port, '127.0.0.1');
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write('POST /api/me/storage/sync HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{');
      await pause(30);
      const began = Date.now();
      await Promise.all([stopServer(server), stopServer(server)]);
      assert(Date.now() - began < 1500);
      assert.equal(process.listenerCount('SIGTERM'), listeners);
      await eventually(() => socket.destroyed, 'stalled HTTP socket closed');
      server = await startServer();
      await request(server).get('/ready').expect(200);
      await stopServer(server); server = undefined;
      assert.equal(process.listenerCount('SIGTERM'), listeners);
    });
    await t.test('pending DNS listen is cancelled after the overall startup deadline', async () => {
      await db.ensureDatabaseReady();
      const blocker = createHttpServer();
      await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
      const port = blocker.address().port;
      await new Promise(resolve => blocker.close(resolve));
      let lookup;
      const original = dns.lookup;
      dns.lookup = (_host, _options, callback) => { lookup = callback; };
      config.HOST = 'delayed.fixture.invalid'; config.PORT = port; config.STARTUP_TIMEOUT_MS = 80;
      try {
        const attempt = startServer();
        await eventually(() => lookup, 'listen awaiting DNS');
        await assert.rejects(attempt, { code: 'RUNTIME_TIMEOUT' });
        lookup(null, '127.0.0.1', 4);
        await pause(30);
      } finally { dns.lookup = original; config.HOST = '127.0.0.1'; config.PORT = 0; config.STARTUP_TIMEOUT_MS = 2000; }
      await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(port, '127.0.0.1', resolve); });
      await new Promise(resolve => blocker.close(resolve));
    });
    await t.test('HTTP inactivity timeout destroys stalled socket and preserves service', async () => {
      const originalTimeout = config.HTTP_IDLE_TIMEOUT_MS;
      config.HTTP_IDLE_TIMEOUT_MS = 70;
      try {
        server = await startServer();
        assert.equal(server.requestTimeout, config.HTTP_REQUEST_TIMEOUT_MS);
        assert.equal(server.headersTimeout, Math.min(config.HTTP_HEADERS_TIMEOUT_MS, config.HTTP_REQUEST_TIMEOUT_MS));
        assert.equal(server.keepAliveTimeout, config.HTTP_KEEP_ALIVE_TIMEOUT_MS);
        const socket = connect(server.address().port, '127.0.0.1');
        socket.on('error', () => {});
        await once(socket, 'connect');
        await eventually(() => socket.destroyed, 'HTTP idle timeout closed socket');
        await request(server).get('/health').expect(200);
        await stopServer(server); server = undefined;
      } finally { config.HTTP_IDLE_TIMEOUT_MS = originalTimeout; }
    });
    await t.test('database outage makes readiness and admission 503 while liveness remains 200', async () => {
      let online = true;
      const upstream = new URL(testUrl);
      proxy = createTcpServer(socket => {
        sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
        if (!online) { socket.resume(); return; }
        const remote = connect(Number(upstream.port || 5432), upstream.hostname);
        sockets.add(remote); remote.once('close', () => sockets.delete(remote)); remote.on('error', () => socket.destroy());
        socket.pipe(remote); remote.pipe(socket);
      });
      await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
      const url = new URL(scoped); url.hostname = '127.0.0.1'; url.port = String(proxy.address().port);
      config.DATABASE_URL = url.toString();
      server = await startServer();
      await request(server).get('/ready').expect(200);
      online = false;
      for (const socket of sockets) socket.destroy();
      await pause(30);
      await request(server).get('/ready').expect(503, { ok: false });
      await request(server).get('/health').expect(200, { ok: true });
      await request(server).get('/api/profiles/missing').expect(503).expect(response => assert.equal(response.body.code, 'RATE_LIMIT_UNAVAILABLE'));
      online = true;
      for (const socket of sockets) socket.destroy();
      await eventually(() => db.checkDatabaseReadiness(), 'DB readiness recovers');
      online = false;
      for (const socket of sockets) socket.destroy();
      await pause(20);
      const pendingProbe = db.checkDatabaseReadiness();
      await pause(10);
      await stopServer(server); server = undefined;
      assert.equal(await pendingProbe, false);
      await eventually(() => sockets.size === 0, 'pending DB connection closed after shutdown');
      await new Promise(resolve => proxy.close(resolve)); proxy = undefined;
      config.DATABASE_URL = scoped.toString();
    });
    await t.test('two processes share password auth budget and hold AI lease beyond HTTP timeout until actual settle', async () => {
      const env = { ...process.env, DATABASE_URL: scoped.toString(), RATE_LIMIT_AUTH_MAX: '2', RATE_LIMIT_AUTH_WINDOW_MS: '60000', RATE_LIMIT_AI_MAX: '10', RATE_LIMIT_LEASE_MS: '800', AI_TIMEOUT_MS: '35' };
      for (let i = 0; i < 2; i++) children.push(child(env));
      await eventually(() => children.every(child => child.messages.some(message => message.port)), children.map(child => child.output()).join('\n'));
      const origins = children.map(child => `http://127.0.0.1:${child.messages.find(message => message.port).port}`);
      for (const origin of origins) assert.equal((await fetch(`${origin}/api/auth/sign-in/email`, { method: 'POST' })).status, 200);
      const rejected = await fetch(`${origins[0]}/api/auth/sign-up/email`, { method: 'POST' });
      assert.equal(rejected.status, 429); assert(Number(rejected.headers.get('retry-after')) > 0);
      const ai = origin => fetch(`${origin}/api/me/ai/recommendations`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Expected-Storage-Key': 'shared-owner' }, body: JSON.stringify({ type: 'general', expectedRevision: 0 }) });
      assert.equal((await ai(origins[0])).status, 503);
      await pause(2400); // Three lease lifetimes: HTTP response has long since ended.
      const busy = await ai(origins[1]); assert.equal(busy.status, 503); assert.equal((await busy.json()).code, 'ROUTE_BUSY');
      children[0].process.send('settle');
      await db.ensureDatabaseReady();
      await eventually(async () => (await db.getDatabasePool().query('SELECT count(*)::int n FROM rate_limit_leases')).rows[0].n === 0, 'actual settlement released shared lease');
      const admitted = await ai(origins[1]); assert.equal((await admitted.json()).code, 'AI_TIMEOUT');
      children[1].process.send('settle');
      await eventually(async () => (await db.getDatabasePool().query('SELECT count(*)::int n FROM rate_limit_leases')).rows[0].n === 0, 'second operation released');
    });
    await t.test('atomic parallel admission, crash expiry, stale renew refusal and bounded cleanup', async () => {
      config.RATE_LIMIT_LEASE_MS = 5000;
      const store = new PostgresRateLimitStore();
      const policy = { key: 'parallel', windowMs: 50, maxRequests: 100, maxConcurrent: 1 };
      const results = await Promise.all(Array.from({ length: 20 }, () => store.acquire(policy)));
      assert.equal(results.filter(result => result.kind === 'allowed').length, 1);
      const lease = results.find(result => result.lease).lease;
      await db.getDatabasePool().query("UPDATE rate_limit_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [lease]);
      assert.equal(await store.renew(lease), false);
      const next = await store.acquire(policy); assert.equal(next.kind, 'allowed');
      await store.release(next.lease);
      await pause(60);
      await Promise.all([store.cleanup(), ...Array.from({ length: 10 }, () => store.acquire({ key: 'cleanup-race', windowMs: 1, maxRequests: 100 }))]);
      await pause(10); await store.cleanup();
      assert.equal((await db.getDatabasePool().query('SELECT count(*)::int n FROM rate_limit_leases')).rows[0].n, 0);
    });
  } finally {
    for (const child of children) {
      if (child.process.exitCode === null) {
        const exit = once(child.process, 'exit');
        const kill = setTimeout(() => child.process.kill('SIGKILL'), 3000);
        child.process.send('stop');
        try { await exit; } finally { clearTimeout(kill); }
      }
    }
    if (server) await stopServer(server);
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await db.closeDatabasePool();
    Object.assign(config, saved);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test('admission disconnect releases late lease without starting operation; renewal failure fails closed', { timeout: 5000 }, async () => {
  const leaseMs = config.RATE_LIMIT_LEASE_MS;
  config.RATE_LIMIT_LEASE_MS = 40;
  let admit;
  let releaseCount = 0;
  let started = 0;
  const store = { acquire: () => new Promise(resolve => { admit = resolve; }), renew: async () => true, release: async () => { releaseCount++; } };
  const app = express();
  app.use(createRateLimitMiddleware({ name: 'late', windowMs: 1000, maxRequests: 10, maxConcurrent: 1, keyGenerator: () => 'key' }, store));
  app.get('/', (_req, res) => { started++; res.end(); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const req = httpRequest(`http://127.0.0.1:${server.address().port}/`);
    req.on('error', () => {}); req.end();
    await eventually(() => admit, 'admission started'); req.destroy(); await pause(20);
    admit({ kind: 'allowed', count: 1, resetAt: Date.now() + 1000, lease: 'late' });
    await eventually(() => releaseCount === 1, 'late lease released'); assert.equal(started, 0);
    const memory = createMemoryRateLimitStore();
    let settle;
    const failed = { ...memory, renew: async () => { throw new Error('synthetic outage'); } };
    const held = express();
    held.use(createRateLimitMiddleware({ name: 'renew', windowMs: 1000, maxRequests: 10, maxConcurrent: 1, keyGenerator: () => 'key' }, failed));
    held.get('/', (_req, res) => { holdRateLimitUntil(res, new Promise(resolve => { settle = resolve; })); res.end(); });
    await request(held).get('/').expect(200); await pause(30);
    assert.equal(rateLimitStoreReady(failed), false);
    await request(held).get('/').expect(503).expect(response => assert.equal(response.body.code, 'RATE_LIMIT_UNAVAILABLE'));
    settle(); await pause(20);
    assert.equal(rateLimitStoreReady(failed), true);
  } finally { config.RATE_LIMIT_LEASE_MS = leaseMs; await new Promise(resolve => server.close(resolve)); }
});
