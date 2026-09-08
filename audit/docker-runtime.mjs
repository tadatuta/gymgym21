// Real image/context regression. Requires Docker; never reads local env or data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'gym21-docker-'));
const prefix = `gym21-o04-${process.pid}`;
const docker = process.env.DOCKER_BINARY || 'docker';
const migrationCount = readdirSync(join(root, 'apps/server/migrations')).filter(p => p.endsWith('.sql')).length;
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...options });
  assert.equal(r.status, 0, `${command} ${args[0]} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
}
const d = (...args) => run(docker, args);
const containers = [], images = [];
const canaries = ['.env', 'apps/server/.env.production', 'apps/client/local.env', 'secrets/key.json', 'apps/server/secrets/key.pem', '.git/canary', '.vscode/canary', 'old-data-storage/user.json', 'trash/user.json', 's.svg', 'apps/server/node_modules/canary', 'packages/contracts/dist/canary', 'apps/server/private.json', 'apps/client/test-results/canary', 'apps/client/playwright-report/canary'];
const excluded = /(^|\/)(?:\.env[^/]*|secrets|credentials|\.git|\.vscode|old-data-storage|trash|node_modules|dist)(\/|$)|(^|\/)s\.svg$|\.(?:env|pem|key|p12|pfx)$/;
function put(path, content) { mkdirSync(dirname(join(temp, path)), { recursive: true }); writeFileSync(join(temp, path), content); }
async function until(check) { for (let n = 0; n < 90; n++) { try { return check(); } catch { await new Promise(r => setTimeout(r, 1000)); } } return check(); }
try {
  // Explicitly copy tracked source only; skip secrets before opening any file.
  const tracked = run('git', ['ls-files', '-z']).split('\0').filter(Boolean);
  for (const path of new Set([...tracked, '.dockerignore'])) {
    if (excluded.test(path) || (path.endsWith('.json') && !/(^|\/)(package(?:-lock)?|tsconfig)\.json$/.test(path))) continue;
    mkdirSync(dirname(join(temp, path)), { recursive: true }); copyFileSync(join(root, path), join(temp, path));
  }
  for (const path of canaries) put(path, 'SYNTHETIC-O04-CANARY');
  put('Dockerfile.probe', 'FROM node:22-alpine\nWORKDIR /context\nCOPY . .\n');
  for (const [kind, file] of [['probe', 'Dockerfile.probe'], ['server', 'apps/server/Dockerfile'], ['client', 'apps/client/Dockerfile']]) {
    // Optional offline accommodation for hosts whose Docker VM cannot reach npm.
    // The supplied directory must contain only integrity-verified npm _cacache data.
    if (kind === 'server' && process.env.GYM21_DOCKER_NPM_CACHE) {
      cpSync(process.env.GYM21_DOCKER_NPM_CACHE, join(temp, '.audit-npm-cache'), { recursive: true });
      for (const dockerfile of ['apps/server/Dockerfile', 'apps/client/Dockerfile']) {
        const source = readFileSync(join(temp, dockerfile), 'utf8');
        put(dockerfile, source.replaceAll('RUN npm ci', 'RUN --mount=type=bind,source=.audit-npm-cache,target=/root/.npm/_cacache,rw npm ci --offline --no-audit'));
      }
      console.log('Fixture-only offline npm cache enabled; production Dockerfiles/lockfile unchanged');
    }
    const tag = `${prefix}-${kind}`; images.push(tag);
    console.log(`Building ${kind} from sanitized synthetic context`);
    run(docker, ['build', '--progress=plain', '-t', tag, '-f', join(temp, file), temp], { stdio: 'inherit' });
  }
  const probe = `const fs=require('fs'); for(const p of ${JSON.stringify(canaries)}) if(fs.existsSync('/context/'+p)) throw Error(p); for(const p of ['package-lock.json','apps/client/package.json','apps/server/src/server.ts','packages/contracts/src/index.ts']) if(!fs.existsSync('/context/'+p)) throw Error('missing '+p)`;
  d('run', '--rm', `${prefix}-probe`, 'node', '-e', probe);
  const inspect = `const fs=require('fs'), assert=require('assert'); assert.notEqual(process.getuid(),0); for(const p of ['src','test','../../apps/client','../../packages/contracts/src']) assert(!fs.existsSync(p),p); for(const p of ['typescript','tsx','esbuild','vite','vitest','supertest','concurrently','dexie']) {let found=false;try{require.resolve(p);found=true}catch{} assert(!found,p)} for(const p of ['better-auth','@better-auth/passkey','@google/genai','express','pg','zod','@gym21/contracts']) require.resolve(p); assert.equal(fs.readdirSync('migrations').filter(p=>p.endsWith('.sql')).length,${migrationCount}); console.log('nonroot, runtime dependency resolution and artifact checks passed')`;
  console.log(d('run', '--rm', `${prefix}-server`, 'node', '-e', inspect));
  d('network', 'create', prefix);
  const password = 'synthetic:@/#password-0123456789012345';
  containers.push(`${prefix}-postgres`);
  d('run', '-d', '--name', containers.at(-1), '--network', prefix, '--network-alias', 'postgres', '-e', 'POSTGRES_USER=gym21', '-e', 'POSTGRES_DB=gym21', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:16-alpine');
  await until(() => d('exec', `${prefix}-postgres`, 'pg_isready', '-U', 'gym21', '-d', 'gym21'));
  containers.push(`${prefix}-server`);
  d('run', '-d', '--name', containers.at(-1), '--network', prefix, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'BETTER_AUTH_SECRET=synthetic-auth-secret-01234567890123456789', '-e', 'HOST=0.0.0.0', '-e', 'DATABASE_SSL=false', `${prefix}-server`, 'node', 'docker-start.mjs');
  const fetchCheck = `const h=await fetch('http://127.0.0.1:8788/health'); if(h.status!==200 || !(await h.json()).ok) throw Error('health failed'); const r=await fetch('http://127.0.0.1:8788/api/auth/get-session'); if(r.status!==200 || await r.text()!=='null') throw Error('auth session failed '+r.status);`;
  await until(() => d('exec', `${prefix}-server`, 'node', '--input-type=module', '-e', fetchCheck));
  const registration = `const assert=(await import('node:assert/strict')).default; const r=await fetch('http://127.0.0.1:8788/api/auth/register/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'docker@example.test',password:'synthetic-test-password-long',name:'Docker',username:'dockertest'})}); assert.equal(r.status,200,await r.clone().text()); const created=await r.json(); const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '); assert.ok(cookie); const session=await fetch('http://127.0.0.1:8788/api/auth/get-session',{headers:{cookie}}); assert.equal(session.status,200); assert.equal((await session.json()).user.id,created.user.id); console.log('real registration and cookie session passed')`;
  console.log(d('exec', `${prefix}-server`, 'node', '--input-type=module', '-e', registration));
  assert.equal(d('exec', `${prefix}-postgres`, 'psql', '-U', 'gym21', '-d', 'gym21', '-Atc', 'SELECT count(*) FROM app_migrations'), String(migrationCount));
  containers.push(`${prefix}-client`);
  d('run', '-d', '--name', containers.at(-1), '--network', prefix, `${prefix}-client`);
  await until(() => d('exec', `${prefix}-client`, 'wget', '-qO-', 'http://127.0.0.1/'));
  const html = d('exec', `${prefix}-client`, 'wget', '-qO-', 'http://127.0.0.1/');
  assert.equal(d('exec', `${prefix}-client`, 'wget', '-qO-', 'http://127.0.0.1/workouts/example'), html);
  for (const path of ['/sw.js', '/manifest.webmanifest', ...Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g), m => m[1])]) assert.ok(d('exec', `${prefix}-client`, 'wget', '-qO-', `http://127.0.0.1${path}`).length);
  for (const kind of ['server', 'client']) console.log(`${kind} image bytes: ${d('image', 'inspect', `${prefix}-${kind}`, '--format', '{{.Size}}')}`);
  console.log('PASS: ignored synthetic secrets/artifacts, production-only nonroot server, all migrations, registration/cookie session and health HTTP, client SPA/assets/service worker');
} finally {
  for (const name of containers.reverse()) spawnSync(docker, ['rm', '-f', '-v', name], { env, stdio: 'ignore' });
  spawnSync(docker, ['network', 'rm', prefix], { env, stdio: 'ignore' });
  for (const tag of images) spawnSync(docker, ['image', 'rm', tag], { env, stdio: 'ignore' });
  rmSync(temp, { recursive: true, force: true });
}
