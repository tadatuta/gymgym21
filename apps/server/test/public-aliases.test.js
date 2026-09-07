import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
const testUrl = process.env.GYM21_TEST_DATABASE_URL;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;
process.env.BETTER_AUTH_SECRET = 'synthetic-public-alias-test-secret';
const schema = `public_alias_${randomUUID().replaceAll('-', '')}`;
let admin;
if (testUrl) {
  admin = new Pool({ connectionString: testUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(testUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
}
const { defaultStorageRepository: repository } = await import('../dist/storage.js');
const { AuthMetaService, ensureAuthDatabaseSchema, getAuthPool, closeAuthPool } = await import('../dist/auth-meta.js');
const { closeDatabasePool } = await import('../dist/database.js');
test('public aliases use authoritative Telegram binding and retain privacy and collision protection', { skip: !testUrl }, async () => {
  try {
    await ensureAuthDatabaseSchema();
    const pool = getAuthPool();
    const key = `u_${randomUUID()}`;
    await pool.query('INSERT INTO "user" (id, name, email) VALUES ($1, $1, $2)', ['owner', 'owner@example.invalid']);
    await AuthMetaService.ensureStorageBinding('owner', () => key);
    for (const [alias, type] of [['id_123456789', 'telegram_id'], ['canonical', 'canonical'], ['old_telegram', 'telegram_username']]) {
      await AuthMetaService.claimAlias('owner', alias, type);
    }
    const data = { workoutTypes: [], workouts: [], logs: [], profile: { id: 'me', displayName: 'Owner', isPublic: true, createdAt: '2026-09-01T00:00:00Z' } };
    await repository.replaceSnapshot(key, data);
    for (const alias of ['id_123456789', 'CANONICAL', '@old_telegram', `id_${key}`]) {
      assert.equal((await repository.findPublicProfileByIdentifier(alias))?.displayName, 'Owner');
    }
    for (const patch of [{ isPublic: false }, { isPublic: true, isDeleted: true }]) {
      await repository.replaceSnapshot(key, { ...data, profile: { ...data.profile, ...patch } });
      assert.equal(await repository.findPublicProfileByIdentifier('id_123456789'), null);
    }
    await repository.replaceSnapshot(key, data);
    await repository.replaceSnapshot('legacy', { ...data, profile: { ...data.profile, displayName: 'Legacy', username: 'legacy_name' } });
    assert.equal((await repository.findPublicProfileByIdentifier('legacy_name'))?.displayName, 'Legacy');
    await pool.query("INSERT INTO public_profile_aliases (alias_lower, alias, storage_key, type) VALUES ('id_123456789', 'id_123456789', 'legacy', 'storage_id')");
    assert.equal(await repository.findPublicProfileByIdentifier('id_123456789'), null);
    await pool.query('INSERT INTO "user" (id, name, email) VALUES ($1, $1, $2)', ['unbound', 'unbound@example.invalid']);
    await AuthMetaService.claimAlias('unbound', 'id_987654321', 'telegram_id');
    assert.equal(await repository.findPublicProfileByIdentifier('id_987654321'), null);
    assert.equal(await repository.findPublicProfileByIdentifier('missing'), null);
  } finally {
    await closeAuthPool();
    await closeDatabasePool();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
