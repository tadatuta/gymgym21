import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Pool } from 'pg';

const exec = promisify(execFile);
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
const schema = `import_${randomUUID().replaceAll('-', '')}`;
const pristine = `${schema}_pristine`;
let admin;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
process.env.BETTER_AUTH_SECRET = 'synthetic-import-regression-secret';
function schemaUrl(name) {
  const url = new URL(testUrl);
  url.searchParams.set('options', `-csearch_path=${name}`);
  return url.toString();
}
if (testUrl) {
  admin = new Pool({ connectionString: testUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE SCHEMA "${pristine}"`);
  process.env.DATABASE_URL = schemaUrl(schema);
}
const { defaultStorageRepository: repository } = await import('../dist/storage.js');
const { getDatabasePool, closeDatabasePool } = await import('../dist/database.js');
const { closeAuthPool } = await import('../dist/auth-meta.js');
const cli = fileURLToPath(new URL('../scripts/import-storage-json.mjs', import.meta.url));
const entity = (id, name = id) => ({ id, name });
async function run(files, flags = [], databaseUrl = process.env.DATABASE_URL, manifest) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gym21-import-'));
  try {
    for (const [name, data] of Object.entries(files)) await writeFile(path.join(dir, `${name}.json`), typeof data === 'string' ? data : JSON.stringify(data));
    const args = [cli, '--dir', dir, ...flags];
    if (manifest !== undefined) {
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      args.push('--manifest', path.join(dir, 'manifest.json'));
    }
    try {
      const result = await exec(process.execPath, args, { env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 15000 });
      return { code: 0, report: JSON.parse(result.stdout) };
    } catch (error) {
      assert.equal(error.killed, false, 'CLI must close all pools and terminate');
      return { code: error.code, report: JSON.parse(error.stdout) };
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function state() {
  const result = {};
  for (const table of ['storage_roots', 'storage_profiles', 'storage_workout_types', 'storage_workouts', 'storage_logs', 'storage_sync_receipts', 'public_profile_aliases', 'public_profile_cache', 'user_storage_binding']) {
    result[table] = (await getDatabasePool().query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
  }
  return result;
}
const context = { kind: 'better-auth', storageKey: 'existing', authUser: { id: 'account', username: null } };
const sync = (batchId, cursor, changes = {}) => repository.sync('existing', { protocolVersion: 1, batchId, cursor, changes }, context);

test('CLI validates first, commits one plan, and preserves client cursors', { skip: !testUrl }, async (t) => {
  try {
    const now = '2026-09-01T00:00:00Z';
    const initial = await sync('old-batch', 0, { workoutTypes: [entity('old'), entity('keep')],
      workouts: [{ id: 'W', startTime: now, status: 'finished', isManual: false, pauseIntervals: [] }],
      logs: [{ id: 'L', workoutTypeId: 'old', workoutId: 'W', date: now, reps: 3 }],
      profile: { id: 'me', isPublic: false, createdAt: now },
    });
    await getDatabasePool().query(`INSERT INTO "user" (id, name, email) VALUES ('account', 'Account', 'synthetic@example.test'), ('other', 'Other', 'other@example.test')`);
    await t.test('report paths cannot overwrite sources or manifest, including symlinks', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'gym21-report-'));
      try {
        const source = path.join(dir, 'existing.json');
        const manifest = path.join(dir, 'manifest.json');
        const outside = await mkdtemp(path.join(tmpdir(), 'gym21-report-link-'));
        try {
          await writeFile(source, '{invalid');
          await writeFile(manifest, '[]');
          await symlink(source, path.join(outside, 'linked.json'));
          for (const target of [source, manifest, path.join(outside, 'linked.json')]) {
            await assert.rejects(exec(process.execPath, [cli, '--dir', dir, '--manifest', manifest, '--report', target, '--apply'],
              { env: process.env, timeout: 15000 }), (error) => error.code === 1 && error.stdout.includes('--report must be outside'));
            assert.equal(await readFile(source, 'utf8'), '{invalid');
            assert.equal(await readFile(manifest, 'utf8'), '[]');
          }
        } finally { await rm(outside, { recursive: true, force: true }); }
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
    await t.test('dry-run on pristine schema creates no tables and does not hang', async () => {
      const result = await run({ existing: { workoutTypes: [entity('new')] } }, ['--dry-run', '--truncate-storage'], schemaUrl(pristine));
      assert.equal(result.code, 0);
      assert.equal(result.report.status, 'validated');
      assert.deepEqual(result.report.processed, []);
      assert.equal((await admin.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1', [pristine])).rowCount, 0);
    });
    await t.test('invalid second JSON and invalid manifests with truncate leave all data unchanged', async () => {
      const before = await state();
      for (const [files, manifest] of [
        [{ existing: { workoutTypes: [entity('new')] }, z: '{bad' }, undefined],
        [{ existing: { logs: [] } }, {}],
        [{ existing: { logs: [] } }, [{ sourceKey: 'missing', storageKey: 'existing' }]],
        [{ existing: { logs: [] } }, [{ sourceKey: 'existing' }, { sourceKey: 'existing' }]],
        [{ existing: { logs: [] }, z: { logs: [] } }, [{ sourceKey: 'z', storageKey: 'existing' }]],
        [{ existing: { logs: [] } }, [{ sourceKey: 'existing', storageKey: 'bad key' }]],
      ]) {
        const result = await run(files, ['--apply', '--truncate-storage'], undefined, manifest);
        assert.equal(result.code, 1, JSON.stringify(result));
        assert.deepEqual(result.report.processed, []);
        assert.deepEqual(await state(), before);
      }
    });
    await t.test('missing source directory or manifest fails without database effects', async () => {
      const before = await state();
      const dir = await mkdtemp(path.join(tmpdir(), 'gym21-missing-'));
      try {
        for (const args of [['--dir', path.join(dir, 'absent')], ['--dir', dir, '--manifest', path.join(dir, 'absent.json')]]) {
          await assert.rejects(exec(process.execPath, [cli, ...args, '--apply', '--truncate-storage'], { env: process.env, timeout: 15000 }),
            (error) => error.code === 1 && JSON.parse(error.stdout).processed.length === 0);
          assert.deepEqual(await state(), before);
        }
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
    await t.test('malformed fields cannot be hidden by legacy defaults or date fallback', async () => {
      const before = await state();
      for (const data of [
        { workoutTypes: [entity('x'), entity('x')] }, { logs: null }, { profile: [] },
        { workoutTypes: [{ ...entity('x'), updatedAt: 'bad date' }] },
        { logs: [{ id: 'x', workoutTypeId: 'old', date: '2026-02-30T00:00:00Z' }] },
        { logs: [{ id: 'x', workoutTypeId: 'old', date: '2026-01-01T00:00:00Z', weight: '<img>' }] },
        { profile: { isPublic: 'true' } }, { profile: { telegramUserId: '123' } },
      ]) {
        assert.equal((await run({ existing: data }, ['--apply'])).code, 1);
        assert.deepEqual(await state(), before);
      }
    });
    await t.test('skip-invalid skips malformed source files, but truncate never skips', async () => {
      const files = { existing: { workoutTypes: [entity('keep', 'changed')] }, invalid: '{' };
      const before = await state();
      assert.equal((await run(files, ['--apply', '--skip-invalid', '--truncate-storage'])).code, 1);
      assert.deepEqual(await state(), before);
      const result = await run(files, ['--apply', '--skip-invalid']);
      assert.equal(result.code, 0);
      assert.equal(result.report.processed.length, 1);
      assert.equal(result.report.skipped.length, 1);
      const after = await sync('pull', initial.cursor);
      assert.ok(after.cursor > initial.cursor);
      assert.equal(after.changes.workoutTypes.find((x) => x.id === 'old').isDeleted, true);
      assert.equal(after.changes.workoutTypes.find((x) => x.id === 'keep').name, 'changed');
      assert.equal(after.changes.workouts[0].isDeleted, true);
      assert.equal(after.changes.logs[0].isDeleted, true);
      assert.equal(after.changes.profile.isDeleted, true);
      await sync('old-batch', 0, { workoutTypes: [entity('old'), entity('keep')] });
      assert.equal((await repository.readSnapshot('existing')).workoutTypes.find((x) => x.id === 'old').isDeleted, true);
    });
    await t.test('binding preflight errors abort every file even with skip-invalid', async () => {
      await getDatabasePool().query("INSERT INTO user_storage_binding(user_id, storage_key) VALUES ('other', 'occupied')");
      const before = await state();
      for (const mapping of [
        [{ sourceKey: 'existing', userId: 'unknown' }],
        [{ sourceKey: 'existing', userId: 'other' }],
        [{ sourceKey: 'existing', storageKey: 'occupied', userId: 'account' }],
      ]) {
        const result = await run({ existing: { logs: [] }, z: { logs: [] } }, ['--apply', '--skip-invalid'], undefined, mapping);
        assert.equal(result.code, 1);
        assert.deepEqual(await state(), before);
      }
    });
    await t.test('write-time failure rolls back previous snapshot and binding writes', async () => {
      await getDatabasePool().query(`CREATE FUNCTION reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'explode' THEN RAISE EXCEPTION 'synthetic write failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_import BEFORE INSERT OR UPDATE ON storage_workout_types FOR EACH ROW EXECUTE FUNCTION reject_import()`);
      const before = await state();
      const result = await run({ existing: { logs: [] }, z: { workoutTypes: [entity('x', 'explode')] } }, ['--apply'], undefined,
        [{ sourceKey: 'existing', userId: 'account' }]);
      assert.equal(result.code, 1);
      assert.equal(result.report.status, 'rolled-back');
      assert.deepEqual(result.report.processed, []);
      assert.deepEqual(await state(), before);
      await getDatabasePool().query('DROP TRIGGER reject_import ON storage_workout_types; DROP FUNCTION reject_import()');
    });
    await t.test('truncate rejects uncovered roots; successful complete replacement binds atomically and preserves receipts', async () => {
      const before = await state();
      assert.equal((await run({ z: { logs: [] } }, ['--apply', '--truncate-storage'])).code, 1);
      assert.deepEqual(await state(), before);
      const cursor = (await sync('cursor', 0)).cursor;
      const result = await run({ existing: { workoutTypes: [entity('new')], profile: { displayName: 'Legacy defaults' } } }, ['--apply', '--truncate-storage'], undefined,
        [{ sourceKey: 'existing', userId: 'account' }]);
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(result.report.status, 'committed');
      assert.equal((await getDatabasePool().query("SELECT storage_key FROM user_storage_binding WHERE user_id='account'")).rows[0].storage_key, 'existing');
      const after = await sync('pull-later', cursor);
      assert.ok(after.cursor > cursor);
      assert.equal(after.changes.workoutTypes.find((x) => x.id === 'keep').isDeleted, true);
      assert.equal(after.changes.workoutTypes.find((x) => x.id === 'new').name, 'new');
      assert.equal(after.changes.profile.displayName, 'Legacy defaults');
      const snapshot = await repository.readSnapshot('existing');
      await sync('old-batch', 0, { workoutTypes: [entity('old')] });
      assert.deepEqual(await repository.readSnapshot('existing'), snapshot);
    });
    await t.test('profile alias collisions abort before any replacement', async () => {
      await getDatabasePool().query("INSERT INTO user_alias (id,user_id,alias,alias_lower,type) VALUES ('alias', 'other','owned','owned','canonical')");
      const before = await state();
      const result = await run({ z: { profile: { username: 'owned' } } }, ['--apply']);
      assert.equal(result.code, 1);
      assert.deepEqual(await state(), before);
    });
  } finally {
    await Promise.all([closeDatabasePool(), closeAuthPool()]);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.query(`DROP SCHEMA "${pristine}" CASCADE`);
    await admin.end();
  }
});
