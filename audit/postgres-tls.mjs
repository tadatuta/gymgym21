// Disposable PostgreSQL, synthetic certificates only; never reads application env files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeImage = process.env.GYM21_TLS_RUNTIME_IMAGE;
assert(runtimeImage, 'Set GYM21_TLS_RUNTIME_IMAGE to the current non-root server runtime image');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'gym21-tls-')));
const name = `gym21-tls-${randomUUID()}`;
const docker = (...args) => execFileSync(process.env.DOCKER_BINARY || 'docker', args, { encoding: 'utf8' });
const openssl = (...args) => execFileSync('openssl', args, { cwd: temp, stdio: 'pipe' });
try {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Gym21 disposable CA');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
  writeFileSync(join(temp, 'extensions'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'extensions');
  docker('run', '-d', '--name', name, '--tmpfs', '/var/lib/postgresql/data', '--tmpfs', '/tls', '-p', '127.0.0.1::5432', '-v', `${temp}:/fixture:ro`, '-e', 'POSTGRES_PASSWORD=synthetic-test-only', '--entrypoint', 'sh', 'postgres:16-alpine', '-c', 'cp /fixture/server.key /fixture/server.pem /tls/ && chown postgres:postgres /tls/* && chmod 600 /tls/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.pem -c ssl_key_file=/tls/server.key');
  const port = docker('port', name, '5432/tcp').trim().split(':').at(-1);
  const deadline = Date.now() + 30000;
  while (true) {
    try { docker('exec', name, 'pg_isready', '-U', 'postgres'); break; }
    catch { assert(Date.now() < deadline, 'disposable PostgreSQL readiness'); await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  execFileSync(process.execPath, ['--test', 'apps/server/test/database-tls.test.js'], { cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, GYM21_TLS_TEST_URL: `postgres://postgres:synthetic-test-only@localhost:${port}/postgres`, GYM21_TLS_TEST_CA: join(temp, 'ca.pem') } });
  // Linux runtime uses the production image's non-root node user and read-only CA.
  // Mount only compiled TLS helper (no application secrets or host node_modules).
  docker('run', '--rm', '--network', `container:${name}`, '-v', `${temp}/ca.pem:/run/secrets/postgres-ca.pem:ro`, '-v', `${root}apps/server/dist/database-tls.js:/tmp/database-tls.mjs:ro`, '--entrypoint', 'node', runtimeImage, '--input-type=module', '-e', `import { createRequire } from 'node:module'; import { databaseConnectionOptions } from '/tmp/database-tls.mjs'; const require=createRequire(process.cwd()+'/package.json'); const {Client}=require('pg'); if(process.getuid()===0)throw Error('must be non-root'); const c=new Client(databaseConnectionOptions({DATABASE_URL:'postgres://postgres:synthetic-test-only@localhost:5432/postgres',DATABASE_SSL:true,DATABASE_SSL_CA_FILE:'/run/secrets/postgres-ca.pem'})); try {await c.connect(); const r=await c.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'); if(r.rows[0].ssl!==true)throw Error('TLS required'); console.log('non-root runtime + read-only CA: passed');}finally{await c.end();}`);
  console.log('PostgreSQL TLS fixture and non-root production runtime CA mount: passed');
} finally {
  try { docker('rm', '-f', name); } catch { /* container may not have started */ }
  rmSync(temp, { recursive: true, force: true });
}
