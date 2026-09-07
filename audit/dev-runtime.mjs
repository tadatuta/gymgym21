// Isolated real-source dev smoke test. Never reads the project's .env or user data.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const root = resolve(import.meta.dirname, '..');
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
assert(testUrl, 'Set GYM21_TEST_DATABASE_URL to a disposable PostgreSQL database');
const admin = new pg.Pool({ connectionString: testUrl });
const schema = `dev_${randomUUID().replaceAll('-', '')}`;
const fixture = await mkdtemp(join(tmpdir(), 'gym21-dev-'));
const url = new URL(testUrl);
url.searchParams.set('options', `-csearch_path=${schema}`);
let child;
let output = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    assert(Date.now() < deadline, `${label}\n${output}`);
    await pause(100);
  }
}
async function stop() {
  if (!child) return;
  const pid = child.pid;
  process.kill(-pid, 'SIGINT'); // Terminal Ctrl+C reaches the complete foreground group.
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'parent stopped');
  await waitFor(() => {
    try { process.kill(-pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }, 'no orphan watcher/server/client');
  child = null;
}
async function run(args, cwd, extra = {}) {
  output = '';
  child = spawn('npm', args, { cwd, detached: true, env: {
    PATH: process.env.PATH, HOME: fixture, TMPDIR: tmpdir(),
    ...extra,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
}
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await mkdir(join(fixture, 'apps/server'), { recursive: true });
  await mkdir(join(fixture, 'apps/client'), { recursive: true });
  for (const name of ['package.json']) await cp(join(root, name), join(fixture, name));
  for (const name of ['package.json', 'tsconfig.json', 'src', 'migrations'])
    await cp(join(root, 'apps/server', name), join(fixture, 'apps/server', name), { recursive: true });
  for (const name of ['package.json', 'index.html', 'vite.config.ts', 'src', 'public'])
    await cp(join(root, 'apps/client', name), join(fixture, 'apps/client', name), { recursive: true });
  await mkdir(join(fixture, 'packages/contracts'), { recursive: true });
  for (const name of ['package.json', 'tsconfig.json', 'src'])
    await cp(join(root, 'packages/contracts', name), join(fixture, 'packages/contracts', name), { recursive: true });
  await mkdir(join(fixture, 'node_modules/@gym21'), { recursive: true });
  for (const name of await readdir(join(root, 'node_modules'))) {
    if (name !== '@gym21') await symlink(join(root, 'node_modules', name), join(fixture, 'node_modules', name));
  }
  for (const [name, target] of [['client', 'apps/client'], ['server', 'apps/server'], ['contracts', 'packages/contracts']])
    await symlink(join(fixture, target), join(fixture, 'node_modules/@gym21', name));
  // npm may keep peer-dependent packages in a workspace instead of hoisting them.
  for (const workspace of ['apps/client', 'apps/server', 'packages/contracts']) {
    const dependencies = join(root, workspace, 'node_modules');
    if (await stat(dependencies).then(info => info.isDirectory(), error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) await symlink(dependencies, join(fixture, workspace, 'node_modules'));
  }
  const env = `DATABASE_URL=${url}\nBETTER_AUTH_SECRET=isolated-dev-test-secret-at-least-32-chars\nHOST=127.0.0.1\nPORT=49872\n`;
  await writeFile(join(fixture, '.env'), env);
  await writeFile(join(fixture, 'apps/server/.env'), 'PORT=1\nDATABASE_URL=invalid\n');
  await run(['run', 'dev'], fixture, { PORT: '49873' });
  await waitFor(() => output.includes('Server listening on http://127.0.0.1:49873') && output.includes('Local:'), 'root npm dev clean-dist/env precedence');
  const sharedSource = join(fixture, 'packages/contracts/src/entities.ts');
  const sharedOriginal = await readFile(sharedSource, 'utf8');
  output = '';
  await writeFile(sharedSource, sharedOriginal + '\nconsole.log("SHARED_RESTART_VERIFIED");\n');
  await waitFor(() => output.includes('SHARED_RESTART_VERIFIED') && output.includes('Server listening'), 'shared source restart');
  output = '';
  await writeFile(sharedSource, sharedOriginal);
  await waitFor(() => output.includes('Server listening'), 'shared source restored');
  const source = join(fixture, 'apps/server/src/ai.ts');
  const original = await readFile(source, 'utf8');
  output = '';
  await writeFile(source, original + '\nconsole.log("DEV_RESTART_VERIFIED");\n');
  await waitFor(() => output.includes('DEV_RESTART_VERIFIED') && output.includes('Server listening'), 'imported source restart');
  output = '';
  await writeFile(source, original + '\nconst = ;\n');
  await waitFor(() => output.includes('ERROR') || output.includes('TransformError'), 'actionable transform error');
  output = '';
  await writeFile(source, original);
  await waitFor(() => output.includes('Server listening'), 'recovery after transform error');
  await stop();
  await run(['run', 'dev'], join(fixture, 'apps/server'));
  await waitFor(() => output.includes('Server listening on http://127.0.0.1:49872'), 'workspace uses root env');
  await stop();
  await rm(join(fixture, '.env'));
  await run(['run', 'dev:server'], fixture, { DATABASE_URL: url.href, BETTER_AUTH_SECRET: 'isolated-dev-test-secret-at-least-32-chars', PORT: '49873', HOST: '127.0.0.1' });
  await waitFor(() => output.includes('Server listening on http://127.0.0.1:49873'), 'exported env without file');
  await stop();
  await run(['run', 'dev:server'], fixture);
  await waitFor(() => output.includes('DATABASE_URL is required'), 'actionable missing configuration');
  await stop();
  console.log('PASS: root/workspace dev, clean dist, root .env, exported precedence/no file, server/shared source restart, transform recovery, startup error, Ctrl+C no orphan');
} finally {
  try {
    await stop();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.end();
    await rm(fixture, { recursive: true, force: true });
  }
}
