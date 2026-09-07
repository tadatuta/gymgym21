import assert from 'node:assert/strict';
import { realpathSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configureDockerEnvironment } from '../apps/server/docker-start.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'gym21-compose-')));
// Do not inherit application secrets or Compose overrides from the caller.
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const fixture = Object.fromEntries(readFileSync(join(cwd, '.env.example'), 'utf8')
  .split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
Object.assign(fixture, { POSTGRES_PASSWORD: 'synthetic:@/#password-0123456789012345', BETTER_AUTH_SECRET: 'synthetic-auth-secret-01234567890123456789', PORT: '9999', HOST: '127.0.0.2', POSTGRES_HOST_PORT: '55432', DATABASE_SSL: 'true', APP_BASE_URL: 'https://fixture.invalid', AUTH_BASE_URL: 'https://fixture.invalid/api/auth', ALLOWED_ORIGINS: 'https://fixture.invalid', ALLOWED_ORIGIN: 'https://fixture.invalid', TRUST_PROXY: '2', JSON_BODY_LIMIT: '7mb', PASSKEY_RP_ID: 'fixture.invalid', PASSKEY_RP_NAME: 'Fixture Gym', TELEGRAM_BOT_TOKEN: 'synthetic-token', TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN: 'fixture.invalid', GOOGLE_CLOUD_PROJECT: 'fixture-project', GOOGLE_CLOUD_LOCATION: 'us-central1', GOOGLE_APPLICATION_CREDENTIALS: '/fixture/google.json' });
for (const key of Object.keys(fixture)) {
  if (/^(RATE_LIMIT|AI_)/.test(key)) fixture[key] = key === 'RATE_LIMITS_ENABLED' ? 'false' : String(Number(fixture[key]) + 7);
}
function compose(values, dev = false) {
  const path = join(temp, 'fixture.env');
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n'));
  return spawnSync('/usr/local/bin/docker', ['compose', '--project-name', 'gym21-config-fixture', '--env-file', path, '-f', 'docker-compose.yml', ...(dev ? ['-f', 'docker-compose.dev.yml'] : []), 'config', '--format', 'json'], { cwd, env, encoding: 'utf8' });
}
try {
  const result = compose(fixture);
  assert.equal(result.status, 0, result.stderr);
  const services = JSON.parse(result.stdout).services;
  for (const key of Object.keys(fixture).filter(key => !['APP_PORT', 'DATABASE_URL', 'PORT', 'HOST', 'POSTGRES_HOST_PORT'].includes(key))) assert.equal(services.server.environment[key], fixture[key], key);
  const source = readFileSync(join(cwd, 'apps/server/src/config.ts'), 'utf8');
  for (const [, key] of source.matchAll(/process\.env\.([A-Z_]+)/g)) {
    if (key !== 'DATABASE_URL') assert.ok(key in services.server.environment, `missing config ${key}`);
  }
  assert.equal(services.server.environment.PORT, '8788');
  assert.equal(services.server.environment.HOST, '0.0.0.0');
  assert.ok(!services.postgres.ports?.length);
  const dev = compose(fixture, true);
  assert.equal(dev.status, 0, dev.stderr);
  assert.deepEqual(JSON.parse(dev.stdout).services.postgres.ports.map(({host_ip, published, target}) => [host_ip, published, target]), [['127.0.0.1', '55432', 5432]]);
  for (const key of ['POSTGRES_PASSWORD', 'BETTER_AUTH_SECRET']) {
    assert.notEqual(compose({...fixture, [key]: ''}).status, 0);
    for (const value of ['', 'gym21', 'change-me']) assert.throws(() => configureDockerEnvironment({...fixture, [key]: value}), new RegExp(key));
  }
  const launcher = join(temp, 'docker-start.mjs');
  writeFileSync(launcher, readFileSync(join(cwd, 'apps/server/docker-start.mjs')));
  mkdirSync(join(temp, 'dist'));
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}');
  writeFileSync(join(temp, 'dist/server.js'), "export async function startServer() { if (!process.env.DATABASE_URL) throw Error('missing URL'); console.log('started fixture server'); }");
  const smoke = spawnSync(process.execPath, [launcher], {env: {...env, ...fixture}, encoding: 'utf8'});
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.match(smoke.stdout, /started fixture server/);
  const rejected = spawnSync(process.execPath, [launcher], {env: {...env, ...fixture, POSTGRES_PASSWORD: 'gym21'}, encoding: 'utf8'});
  assert.notEqual(rejected.status, 0);
  assert.doesNotMatch(rejected.stdout, /started fixture server/);
  assert.match(rejected.stderr, /POSTGRES_PASSWORD/);
  const special = {...fixture, POSTGRES_DB: 'db/@:# name', POSTGRES_USER: 'user/@:# name'};
  configureDockerEnvironment(special);
  assert.equal(decodeURIComponent(new URL(special.DATABASE_URL).pathname.slice(1)), special.POSTGRES_DB);
  assert.equal(decodeURIComponent(new URL(special.DATABASE_URL).username), special.POSTGRES_USER);
  const server = { ...services.server.environment, DATABASE_URL: 'postgres://wrong:wrong@wrong/wrong' };
  configureDockerEnvironment(server);
  const url = new URL(server.DATABASE_URL);
  assert.equal(url.hostname, 'postgres');
  assert.equal(url.port, '5432');
  assert.equal(decodeURIComponent(url.password), services.postgres.environment.POSTGRES_PASSWORD);
  assert.equal(decodeURIComponent(url.username), services.postgres.environment.POSTGRES_USER);
  assert.equal(decodeURIComponent(url.pathname.slice(1)), services.postgres.environment.POSTGRES_DB);
  assert.deepEqual(services.server.command, ['node', 'docker-start.mjs']);
  console.log('Compose fixtures passed: all runtime settings, fixed upstream, private DB/dev loopback, required secrets, encoded shared credentials. No containers started.');
} finally {
  rmSync(temp, {recursive: true, force: true});
}
