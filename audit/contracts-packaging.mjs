// Clean workspace/package smoke without project env files or user data.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'gym21-contracts-')));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), npm_config_fetch_retries: '0', npm_config_fetch_timeout: '30000', npm_config_cache: process.env.npm_config_cache ?? join(process.env.HOME, '.npm') };
async function run(command, args, cwd = fixture) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally { clearTimeout(timeout); }
  assert.equal(code, 0, `${command} ${args.join(' ')}\n${output}`);
  console.log(`PASS: ${command} ${args.join(' ')} (${cwd === fixture ? 'root' : cwd.slice(fixture.length + 1)})`);
}
async function cleanBuilds() {
  for (const dir of ['packages/contracts', 'apps/client', 'apps/server'])
    await rm(join(fixture, dir, 'dist'), { recursive: true, force: true });
}
try {
  for (const name of ['package.json', 'package-lock.json']) await cp(join(root, name), join(fixture, name));
  for (const [dir, files] of [
    ['packages/contracts', ['package.json', 'tsconfig.json', 'src', 'test']],
    ['apps/client', ['package.json', 'tsconfig.json', 'src', 'index.html', 'vite.config.ts', 'public']],
    ['apps/server', ['package.json', 'tsconfig.json', 'src', 'test', 'migrations', 'scripts']],
  ]) {
    await mkdir(join(fixture, dir), { recursive: true });
    for (const name of files) await cp(join(root, dir, name), join(fixture, dir, name), { recursive: true });
  }
  await run('npm', ['ci', ...(process.argv.includes('--online') ? [] : ['--offline']), '--no-audit', '--no-fund']);
  assert.equal(await realpath(join(fixture, 'node_modules/@gym21/contracts')), join(fixture, 'packages/contracts'));
  await run('npm', ['run', 'typecheck']); // no emitted shared declarations required
  await run('npm', ['run', 'build']);
  await cleanBuilds();
  await run('npm', ['run', 'build'], join(fixture, 'apps/server')); // prebuild must build shared independently
  await rename(join(fixture, 'packages/contracts/src'), join(fixture, 'packages/contracts/source-hidden'));
  await run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { backupDataSchema } from '@gym21/contracts';
    import { backupDataSchema as serverSchema } from './apps/server/dist/backup-validation.js';
    import { dayKey } from './apps/server/dist/training-time.js';
    assert.equal(serverSchema, backupDataSchema);
    assert(import.meta.resolve('@gym21/contracts').endsWith('/packages/contracts/dist/index.js'));
    assert.equal(dayKey('2026-09-01T22:00:00Z', 'Europe/Moscow'), '2026-09-02');
  `]); // production imports must use JS even with no TS source available
  await rename(join(fixture, 'packages/contracts/source-hidden'), join(fixture, 'packages/contracts/src'));
  await cleanBuilds();
  await run('npm', ['run', 'build'], join(fixture, 'apps/client')); // browser source export, no shared dist
  await cleanBuilds();
  await run('npm', ['run', 'test', '--', 'src/storage/backup.test.ts', 'src/services/sync.test.ts', 'src/main.markup.test.ts'], join(fixture, 'apps/client'));
  await run('npm', ['run', 'test'], join(fixture, 'packages/contracts'));
  for (const app of ['client', 'server']) {
    const dockerfile = await readFile(join(root, `apps/${app}/Dockerfile`), 'utf8');
    assert(dockerfile.indexOf('COPY packages/contracts/package.json packages/contracts/package.json') < dockerfile.indexOf('RUN npm ci'));
    assert(dockerfile.includes('COPY packages/contracts packages/contracts'));
    if (app === 'server') assert(dockerfile.includes('COPY --from=build /app/packages/contracts /app/packages/contracts'));
  }
  console.log('PASS: clean npm workspace links, root/standalone build/typecheck/test, production JS with source absent, Docker shared COPY targets');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
