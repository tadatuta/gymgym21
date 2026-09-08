import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { databaseConnectionOptions } from '../dist/database-tls.js';

const base = { DATABASE_URL: 'postgres://synthetic:password@localhost/test', DATABASE_SSL: true, DATABASE_SSL_CA_FILE: '' };
test('TLS settings reject URL overrides before pg can load files; safe diagnostics', () => {
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat', 'SSL', '%73slmode']) {
    for (const value of ['', '0', 'false', 'no-verify', '/secret/not-readable']) {
      for (const enabled of [true, false]) assert.throws(() => databaseConnectionOptions({ ...base, DATABASE_SSL: enabled, DATABASE_URL: `${base.DATABASE_URL}?${key}=${value}` }), /^Error: Remove SSL parameters/);
    }
  }
  assert.throws(() => databaseConnectionOptions({ ...base, DATABASE_URL: 'secret-invalid-url' }), /^Error: DATABASE_URL must be a valid PostgreSQL URL$/);
  assert.throws(() => databaseConnectionOptions({ ...base, DATABASE_SSL_CA_FILE: '/not-present/sensitive-file' }), /^Error: DATABASE_SSL_CA_FILE cannot be read; check the runtime mount and file permissions$/);
  assert.throws(() => databaseConnectionOptions({ ...base, DATABASE_SSL: false, DATABASE_SSL_CA_FILE: '/unused' }), /requires DATABASE_SSL=true/);
  const temp = mkdtempSync(join(tmpdir(), 'gym21-tls-unit-'));
  try {
    for (const value of ['', 'not a certificate', '-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----']) {
      const file = join(temp, 'bad.pem'); writeFileSync(file, value);
      assert.throws(() => databaseConnectionOptions({ ...base, DATABASE_SSL_CA_FILE: file }), /valid PEM certificate bundle/);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  const literalPercentHost = databaseConnectionOptions({ ...base, DATABASE_URL: `${base.DATABASE_URL}?host=local%2568ost` });
  assert.equal(literalPercentHost.ssl.checkServerIdentity('ignored', { subjectaltname: 'DNS:other.test', subject: { CN: 'other.test' } }).host, 'local%68ost');
  const old = process.env.PGSSLMODE;
  try {
    for (const mode of ['disable', 'no-verify', 'require', 'verify-ca']) {
      process.env.PGSSLMODE = mode;
      assert.equal(new Client(databaseConnectionOptions(base)).ssl.rejectUnauthorized, true);
      assert.equal(new Client(databaseConnectionOptions({ ...base, DATABASE_SSL: false })).ssl, false);
    }
  } finally { if (old === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = old; }
});

test('real PostgreSQL verifies CA and actual hostname; explicit non-TLS ignores PGSSLMODE', { skip: !process.env.GYM21_TLS_TEST_URL }, async () => {
  async function query(overrides) {
    const client = new Client({ ...databaseConnectionOptions({ ...base, DATABASE_URL: process.env.GYM21_TLS_TEST_URL, ...overrides }), connectionTimeoutMillis: 2000 });
    try { await client.connect(); return (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl; }
    finally { await client.end(); }
  }
  await assert.rejects(query({}), /self-signed|unable to verify|certificate/i);
  assert.equal(await query({ DATABASE_SSL_CA_FILE: process.env.GYM21_TLS_TEST_CA }), true);
  const viaQuery = new URL(process.env.GYM21_TLS_TEST_URL);
  viaQuery.hostname = '127.0.0.1'; viaQuery.searchParams.append('host', '127.0.0.1'); viaQuery.searchParams.append('host', 'localhost');
  assert.equal(await query({ DATABASE_URL: viaQuery.href, DATABASE_SSL_CA_FILE: process.env.GYM21_TLS_TEST_CA }), true);
  viaQuery.searchParams.append('host', '127.0.0.1');
  await assert.rejects(query({ DATABASE_URL: viaQuery.href, DATABASE_SSL_CA_FILE: process.env.GYM21_TLS_TEST_CA }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const wrong = new URL(process.env.GYM21_TLS_TEST_URL); wrong.hostname = '127.0.0.1';
  await assert.rejects(query({ DATABASE_URL: wrong.href, DATABASE_SSL_CA_FILE: process.env.GYM21_TLS_TEST_CA }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const old = process.env.PGSSLMODE;
  try {
    process.env.PGSSLMODE = 'no-verify';
    await assert.rejects(query({}), /self-signed|unable to verify|certificate/i);
    process.env.PGSSLMODE = 'require';
    assert.equal(await query({ DATABASE_SSL: false }), false);
  } finally { if (old === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = old; }
});


test('startup exposes safe actionable TLS diagnostics', () => {
  for (const [settings, expected] of [
    [{ DATABASE_SSL_CA_FILE: '/sensitive/missing.pem' }, /DATABASE_SSL_CA_FILE cannot be read/],
    [{ DATABASE_URL: `${base.DATABASE_URL}?sslmode=no-verify` }, /Remove SSL parameters from DATABASE_URL/],
  ]) {
    const result = spawnSync(process.execPath, ['dist/server.js'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, DATABASE_URL: base.DATABASE_URL, DATABASE_SSL: 'true', BETTER_AUTH_SECRET: 'synthetic-test-secret-at-least-32-characters', ...settings },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.match(result.stderr, /DATABASE_TLS_CONFIGURATION/);
    assert.doesNotMatch(result.stderr, /sensitive|synthetic:password|postgres:\/\//);
  }
});
