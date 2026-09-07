import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type IdentityReader = Pick<Pool | PoolClient, 'query'>;
export type AliasType = 'canonical' | 'telegram_username' | 'telegram_id';
export class AliasOwnershipError extends Error {
  constructor(alias: string) { super(`Alias already taken: ${alias}`); }
}

export interface AuthUserRecord {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  username: string | null;
  displayUsername: string | null;
  migrationCompleted: boolean;
}

export interface AccountRecord {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  password: string | null;
  telegramUsername: string | null;
}

export function normalizeIdentifier(identifier: string): string {
    return identifier.trim().replace(/^@/, '').toLowerCase();
}

export function normalizeUsername(username: string): string {
    return username.trim().replace(/^@/, '').toLowerCase();
}

export function isValidUsername(username: string): boolean {
    return /^[a-z0-9_]{5,32}$/i.test(username);
}

function mapUserRow(row: {
  id: string;
  name: string;
  email: string;
  email_verified: boolean;
  image: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  username: string | null;
  display_username: string | null;
  migration_completed: boolean;
}): AuthUserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    image: row.image,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    username: row.username,
    displayUsername: row.display_username,
    migrationCompleted: row.migration_completed,
  };
}

export async function getUserById(db: IdentityReader, userId: string): Promise<AuthUserRecord | null> {
  const result = await db.query<{
    id: string;
    name: string;
    email: string;
    email_verified: boolean;
    image: string | null;
    created_at: string | Date;
    updated_at: string | Date;
    username: string | null;
    display_username: string | null;
    migration_completed: boolean;
  }>(
    `
      SELECT
        id,
        name,
        email,
        email_verified,
        image,
        created_at,
        updated_at,
        username,
        display_username,
        migration_completed
      FROM "user"
      WHERE id = $1
      LIMIT 1
    `,
    [userId],
  );
  const row = result.rows[0];
  return row ? mapUserRow(row) : null;
}

export async function getUserByEmail(db: IdentityReader, email: string): Promise<AuthUserRecord | null> {
  const result = await db.query<{
    id: string;
    name: string;
    email: string;
    email_verified: boolean;
    image: string | null;
    created_at: string | Date;
    updated_at: string | Date;
    username: string | null;
    display_username: string | null;
    migration_completed: boolean;
  }>(
    `
      SELECT
        id,
        name,
        email,
        email_verified,
        image,
        created_at,
        updated_at,
        username,
        display_username,
        migration_completed
      FROM "user"
      WHERE email = $1
      LIMIT 1
    `,
    [email.toLowerCase()],
  );
  const row = result.rows[0];
  return row ? mapUserRow(row) : null;
}

export async function getAccountsForUser(db: IdentityReader, userId: string): Promise<AccountRecord[]> {
  const result = await db.query<{
    id: string;
    account_id: string;
    provider_id: string;
    user_id: string;
    password: string | null;
    telegram_username: string | null;
  }>(
    `
      SELECT id, account_id, provider_id, user_id, password, telegram_username
      FROM account
      WHERE user_id = $1
    `,
    [userId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    providerId: row.provider_id,
    userId: row.user_id,
    password: row.password,
    telegramUsername: row.telegram_username,
  }));
}

export async function getUserIdByProviderAccount(db: IdentityReader, accountId: string, providerId: string): Promise<string | null> {
  const result = await db.query<{ user_id: string }>(
    `
      SELECT user_id
      FROM account
      WHERE account_id = $1 AND provider_id = $2
      LIMIT 1
    `,
    [accountId, providerId],
  );
  return result.rows[0]?.user_id ?? null;
}

export async function getCanonicalAlias(db: IdentityReader, userId: string): Promise<string | null> {
  const result = await db.query<{ alias: string }>(
    `
      SELECT alias
      FROM user_alias
      WHERE user_id = $1 AND type = $2
      LIMIT 1
    `,
    [userId, 'canonical'],
  );
  return result.rows[0]?.alias ?? null;
}

export async function getPasskeyCount(db: IdentityReader, userId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM passkey WHERE user_id = $1',
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** All alias writers share a transaction lock across the auth and public registries. */
export async function claimUserAliasTx(client: PoolClient, userId: string, alias: string, type: AliasType): Promise<void> {
    const normalized = normalizeIdentifier(alias);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gym21-alias:${normalized}`]);
    const publicOwner = await client.query(
        `SELECT 1 FROM public_profile_aliases p
         WHERE p.alias_lower = $1 AND NOT EXISTS (
           SELECT 1 FROM user_storage_binding b WHERE b.user_id = $2 AND b.storage_key = p.storage_key
         )`, [normalized, userId],
    );
    if (publicOwner.rowCount) throw new AliasOwnershipError(normalized);
    const claimed = await client.query(
        `INSERT INTO user_alias (id, user_id, alias, alias_lower, type, created_at, updated_at)
         VALUES ($1, $2, $3, $3, $4, NOW(), NOW())
         ON CONFLICT (alias_lower)
         DO UPDATE SET alias = EXCLUDED.alias, type = EXCLUDED.type, updated_at = NOW()
         WHERE user_alias.user_id = EXCLUDED.user_id
         RETURNING user_id`, [randomUUID(), userId, normalized, type],
    );
    if (!claimed.rowCount) throw new AliasOwnershipError(normalized);
}

export async function upsertStorageBindingTx(client: PoolClient, userId: string, storageKey: string) {
  await client.query(
    `
      INSERT INTO user_storage_binding (user_id, storage_key, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET storage_key = EXCLUDED.storage_key, updated_at = NOW()
    `,
    [userId, storageKey],
  );
}


export async function ensureStorageBindingTx(client: PoolClient, userId: string, storageKey: string): Promise<string> {
  const existing = await client.query<{storage_key: string}>('SELECT storage_key FROM user_storage_binding WHERE user_id = $1', [userId]);
  if (existing.rows[0]) return existing.rows[0].storage_key;
  const result = await client.query<{storage_key: string}>(
    `INSERT INTO user_storage_binding (user_id, storage_key) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING storage_key`, [userId, storageKey]);
  return result.rows[0]!.storage_key;
}

export async function setCanonicalAliasTx(client: PoolClient, userId: string, username: string): Promise<void> {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) throw new Error('Invalid username');
  await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [userId]);
  await claimUserAliasTx(client, userId, normalized, 'canonical');
  await client.query('UPDATE "user" SET username = $2, display_username = $2, updated_at = NOW() WHERE id = $1', [userId, normalized]);
  await client.query('DELETE FROM user_alias WHERE user_id = $1 AND type = $2 AND alias_lower <> $3', [userId, 'canonical', normalized]);
}

export async function linkProviderAccountTx(client: PoolClient, userId: string, accountId: string, providerId: string): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO account (id, account_id, provider_id, user_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_id, account_id) DO UPDATE SET account_id = EXCLUDED.account_id
     WHERE account.user_id = EXCLUDED.user_id RETURNING user_id`, [randomUUID(), accountId, providerId, userId]);
  return Boolean(result.rowCount);
}
