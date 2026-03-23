import { randomUUID } from 'node:crypto';
import { betterAuth, APIError } from 'better-auth';
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { parseUserOutput } from 'better-auth/db';
import { toNodeHandler } from 'better-auth/node';
import { passkey } from '@better-auth/passkey';
import { bearer } from 'better-auth/plugins';
import { type PoolClient } from 'pg';
import { z } from 'zod';
import { config, HAS_DATABASE } from './config.js';
import {
  AuthMetaService,
  closeAuthPool,
  createPlaceholderEmail,
  ensureAuthDatabaseSchema,
  getAuthPool,
  isPlaceholderEmail,
  isValidUsername,
  normalizeUsername,
} from './auth-meta.js';
import { Storage, type StorageData } from './storage.js';
import { parseTelegramInitData, type TelegramUser, validateTelegramInitData } from './telegram.js';

const TELEGRAM_PROVIDER_ID = 'telegram';

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

interface AccountRecord {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  password: string | null;
}

export interface AuthenticatedRequestContext {
  kind: 'better-auth' | 'telegram-legacy';
  storageKey: string;
  authUser?: AuthUserRecord;
  telegramUser?: TelegramUser;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

const trustedOrigins = Array.from(
  new Set(
    [config.APP_BASE_URL, config.AUTH_ORIGIN, ...config.ALLOWED_ORIGINS]
      .filter(Boolean)
      .map(normalizeOrigin),
  ),
);

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

async function getUserById(userId: string): Promise<AuthUserRecord | null> {
  await ensureAuthDatabaseSchema();
  const result = await getAuthPool().query<{
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

async function getUserByEmail(email: string): Promise<AuthUserRecord | null> {
  await ensureAuthDatabaseSchema();
  const result = await getAuthPool().query<{
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

async function getAccountsForUser(userId: string): Promise<AccountRecord[]> {
  await ensureAuthDatabaseSchema();
  const result = await getAuthPool().query<{
    id: string;
    account_id: string;
    provider_id: string;
    user_id: string;
    password: string | null;
  }>(
    `
      SELECT id, account_id, provider_id, user_id, password
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
  }));
}

async function getUserIdByProviderAccount(accountId: string, providerId: string): Promise<string | null> {
  await ensureAuthDatabaseSchema();
  const result = await getAuthPool().query<{ user_id: string }>(
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

async function getCanonicalAlias(userId: string): Promise<string | null> {
  await ensureAuthDatabaseSchema();
  const result = await getAuthPool().query<{ alias: string }>(
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

async function getPasskeyCount(userId: string): Promise<number> {
  await ensureAuthDatabaseSchema();
  const result = await getAuthPool().query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM passkey WHERE user_id = $1',
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function getTelegramDisplayName(telegramUser: TelegramUser): string {
  const fullName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').trim();
  return fullName || telegramUser.username || `Telegram ${telegramUser.id}`;
}

function validateEmailAddress(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!z.email().safeParse(normalized).success) {
    throw APIError.fromStatus('BAD_REQUEST', { message: 'Некорректный email' });
  }
  return normalized;
}

function validateCanonicalUsername(username: string): string {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) {
    throw APIError.fromStatus('BAD_REQUEST', { message: 'Некорректный username. Разрешены 5-32 символа: буквы, цифры и _' });
  }
  return normalized;
}

function ensurePasswordLength(password: string, min = 8, max = 128) {
  if (password.length < min) {
    throw APIError.fromStatus('BAD_REQUEST', { message: `Пароль должен содержать не меньше ${min} символов` });
  }
  if (password.length > max) {
    throw APIError.fromStatus('BAD_REQUEST', { message: `Пароль должен содержать не больше ${max} символов` });
  }
}

function parseTelegramUserOrThrow(initData: string): TelegramUser {
  if (!validateTelegramInitData(initData)) {
    throw APIError.fromStatus('UNAUTHORIZED', { message: 'Невалидные данные Telegram' });
  }
  const { user } = parseTelegramInitData(initData);
  if (!user?.id) {
    throw APIError.fromStatus('BAD_REQUEST', { message: 'Не удалось определить пользователя Telegram' });
  }
  return user;
}

function hasWorkoutPayload(data: StorageData): boolean {
  return Boolean(data.workouts?.length || data.logs?.length || data.workoutTypes?.length);
}

async function chooseStorageKeyForUser(userId: string, telegramUserId?: number): Promise<string> {
  const existingBinding = await AuthMetaService.getStorageKeyForUser(userId);
  if (!telegramUserId) {
    return existingBinding ?? `u_${userId}`;
  }

  const legacyStorageKey = String(telegramUserId);
  if (!existingBinding) {
    return (await Storage.exists(legacyStorageKey)) ? legacyStorageKey : `u_${userId}`;
  }

  if (existingBinding === legacyStorageKey) {
    return existingBinding;
  }

  if (!(await Storage.exists(legacyStorageKey))) {
    return existingBinding;
  }

  const currentData = await Storage.read(existingBinding);
  if (!hasWorkoutPayload(currentData)) {
    return legacyStorageKey;
  }

  return existingBinding;
}

async function assertNoStorageConflictForTelegramLink(userId: string, telegramUserId: number) {
  const existingBinding = await AuthMetaService.getStorageKeyForUser(userId);
  if (!existingBinding || existingBinding === String(telegramUserId)) {
    return;
  }

  const legacyStorageKey = String(telegramUserId);
  if (!(await Storage.exists(legacyStorageKey))) {
    return;
  }

  const currentData = await Storage.read(existingBinding);
  const legacyData = await Storage.read(legacyStorageKey);

  if (hasWorkoutPayload(currentData) && hasWorkoutPayload(legacyData)) {
    throw APIError.fromStatus('BAD_REQUEST', {
      message: 'Нельзя автоматически связать Telegram: и в текущем аккаунте, и в legacy-данных уже есть тренировки',
    });
  }
}

async function upsertStorageBindingTx(client: PoolClient, userId: string, storageKey: string) {
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

async function getAliasOwnerTx(client: PoolClient, alias: string): Promise<string | null> {
  const result = await client.query<{ user_id: string }>(
    'SELECT user_id FROM user_alias WHERE alias_lower = $1 LIMIT 1',
    [alias.trim().toLowerCase().replace(/^@/, '')],
  );
  return result.rows[0]?.user_id ?? null;
}

async function upsertAliasTx(client: PoolClient, userId: string, alias: string, type: 'canonical' | 'telegram_username' | 'telegram_id' | 'legacy_username') {
  const normalizedAlias = alias.trim().replace(/^@/, '').toLowerCase();
  if (!normalizedAlias) return;

  const ownerId = await getAliasOwnerTx(client, normalizedAlias);
  if (ownerId && ownerId !== userId) {
    throw APIError.fromStatus('BAD_REQUEST', { message: `Identifier already taken: ${normalizedAlias}` });
  }

  await client.query(
    `
      INSERT INTO user_alias (id, user_id, alias, alias_lower, type, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (alias_lower)
      DO UPDATE SET user_id = EXCLUDED.user_id, alias = EXCLUDED.alias, type = EXCLUDED.type, updated_at = NOW()
    `,
    [randomUUID(), userId, normalizedAlias, normalizedAlias, type],
  );
}

async function tryUpsertAliasTx(client: PoolClient, userId: string, alias: string | undefined, type: 'telegram_username' | 'legacy_username') {
  if (!alias) return;
  const normalizedAlias = normalizeUsername(alias);
  if (!isValidUsername(normalizedAlias)) return;
  try {
    await upsertAliasTx(client, userId, normalizedAlias, type);
  } catch {
    // Keep migration flowing even when a legacy alias is occupied elsewhere.
  }
}

async function setCanonicalUsernameTx(client: PoolClient, userId: string, username: string) {
  const normalizedUsername = validateCanonicalUsername(username);
  const ownerId = await getAliasOwnerTx(client, normalizedUsername);
  if (ownerId && ownerId !== userId) {
    throw APIError.fromStatus('BAD_REQUEST', { message: 'Username already taken' });
  }

  await client.query(
    `
      UPDATE "user"
      SET username = $2, display_username = $3, updated_at = NOW()
      WHERE id = $1
    `,
    [userId, normalizedUsername, normalizedUsername],
  );

  await client.query(
    'DELETE FROM user_alias WHERE user_id = $1 AND type = $2 AND alias_lower <> $3',
    [userId, 'canonical', normalizedUsername],
  );

  await upsertAliasTx(client, userId, normalizedUsername, 'canonical');
}

async function linkCredentialPasswordTx(client: PoolClient, userId: string, passwordHash: string) {
  const result = await client.query(
    `
      UPDATE account
      SET password = $2, updated_at = NOW()
      WHERE user_id = $1 AND provider_id = 'credential'
    `,
    [userId, passwordHash],
  );

  if (result.rowCount && result.rowCount > 0) {
    return;
  }

  await client.query(
    `
      INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
      VALUES ($1, $2, 'credential', $3, $4, NOW(), NOW())
    `,
    [randomUUID(), userId, userId, passwordHash],
  );
}

async function linkTelegramAccountTx(client: PoolClient, userId: string, telegramUserId: number) {
  const accountId = String(telegramUserId);
  const existingUserId = await getUserIdByProviderAccount(accountId, TELEGRAM_PROVIDER_ID);
  if (existingUserId && existingUserId !== userId) {
    throw APIError.fromStatus('BAD_REQUEST', { message: 'Этот Telegram уже привязан к другому аккаунту' });
  }

  if (!existingUserId) {
    await client.query(
      `
        INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
      `,
      [randomUUID(), accountId, TELEGRAM_PROVIDER_ID, userId],
    );
  }
}

async function updateMigrationCompletedTx(client: PoolClient, userId: string, completed: boolean) {
  await client.query(
    `
      UPDATE "user"
      SET migration_completed = $2, updated_at = NOW()
      WHERE id = $1
    `,
    [userId, completed],
  );
}

async function updateUserProfileTx(
  client: PoolClient,
  userId: string,
  data: {
    email?: string;
    name?: string;
    image?: string | null;
    migrationCompleted?: boolean;
  },
) {
  const fields: string[] = [];
  const values: Array<string | boolean | null> = [userId];
  let index = 2;

  if (data.email !== undefined) {
    fields.push(`email = $${index++}`);
    values.push(data.email);
  }
  if (data.name !== undefined) {
    fields.push(`name = $${index++}`);
    values.push(data.name);
  }
  if (data.image !== undefined) {
    fields.push(`image = $${index++}`);
    values.push(data.image);
  }
  if (data.migrationCompleted !== undefined) {
    fields.push(`migration_completed = $${index++}`);
    values.push(data.migrationCompleted);
  }

  if (fields.length === 0) return;

  await client.query(
    `
      UPDATE "user"
      SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $1
    `,
    values,
  );
}

async function syncStorageProfile(
  storageKey: string,
  data: {
    username?: string | null;
    name?: string | null;
    image?: string | null;
    telegramUser?: TelegramUser;
  },
) {
  const current = await Storage.read(storageKey);
  const now = new Date().toISOString();

  const nextProfile: StorageData['profile'] = {
    id: current.profile?.id ?? 'me',
    isPublic: current.profile?.isPublic ?? false,
    createdAt: current.profile?.createdAt ?? now,
    updatedAt: now,
    friends: current.profile?.friends ?? [],
    ...current.profile,
  };

  if (data.username) {
    nextProfile.username = data.username;
  }

  if (!current.profile?.displayName && data.name) {
    nextProfile.displayName = data.name;
  }

  if (data.image) {
    nextProfile.photoUrl = data.image;
  }

  if (data.telegramUser) {
    nextProfile.telegramUserId = data.telegramUser.id;
    if (data.telegramUser.username) {
      nextProfile.telegramUsername = data.telegramUser.username;
    }
    if (data.telegramUser.photo_url) {
      nextProfile.photoUrl = data.telegramUser.photo_url;
    }
  }

  await Storage.write(storageKey, {
    ...current,
    profile: nextProfile,
  });
}

function needsCompletion(user: AuthUserRecord, accounts: AccountRecord[]): boolean {
  const hasPassword = accounts.some((account) => account.providerId === 'credential' && Boolean(account.password));
  return !user.username || isPlaceholderEmail(user.email) || !hasPassword || !user.migrationCompleted;
}

async function getSuggestedUsername(userId: string, telegramUserId?: number): Promise<string | null> {
  const user = await getUserById(userId);
  if (user?.username) {
    return user.username;
  }

  const candidates: string[] = [];
  if (telegramUserId) {
    const storageData = await Storage.read(String(telegramUserId));
    if (storageData.profile?.telegramUsername) {
      candidates.push(storageData.profile.telegramUsername);
    }
    if (storageData.profile?.username) {
      candidates.push(storageData.profile.username);
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeUsername(candidate);
    if (isValidUsername(normalized) && (await AuthMetaService.isAliasAvailable(normalized, userId))) {
      return normalized;
    }
  }

  return null;
}

async function ensureTelegramStateForUser(userId: string, telegramUser: TelegramUser): Promise<{ user: AuthUserRecord; storageKey: string }> {
  const legacyStorageKey = String(telegramUser.id);
  const legacyStorage = await Storage.read(legacyStorageKey);
  const preferredUsername = [telegramUser.username, legacyStorage.profile?.username, legacyStorage.profile?.telegramUsername]
    .map((value) => value ? normalizeUsername(value) : null)
    .find((value): value is string => Boolean(value && isValidUsername(value)));
  const storageKey = await chooseStorageKeyForUser(userId, telegramUser.id);

  const client = await getAuthPool().connect();
  try {
    await client.query('BEGIN');
    await upsertStorageBindingTx(client, userId, storageKey);
    await upsertAliasTx(client, userId, `id_${telegramUser.id}`, 'telegram_id');

    const currentUser = await getUserById(userId);
    const currentCanonical = currentUser?.username ?? null;

    if (!currentCanonical && preferredUsername && (await AuthMetaService.isAliasAvailable(preferredUsername, userId))) {
      await setCanonicalUsernameTx(client, userId, preferredUsername);
    }

    if (telegramUser.username) {
      const normalizedTelegramUsername = normalizeUsername(telegramUser.username);
      if ((!currentCanonical || currentCanonical !== normalizedTelegramUsername) && isValidUsername(normalizedTelegramUsername)) {
        await tryUpsertAliasTx(client, userId, normalizedTelegramUsername, 'telegram_username');
      }
    }

    if (legacyStorage.profile?.telegramUsername) {
      const normalizedLegacyUsername = normalizeUsername(legacyStorage.profile.telegramUsername);
      if ((!currentCanonical || currentCanonical !== normalizedLegacyUsername) && isValidUsername(normalizedLegacyUsername)) {
        await tryUpsertAliasTx(client, userId, normalizedLegacyUsername, 'legacy_username');
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const refreshedUser = await getUserById(userId);
  if (!refreshedUser) {
    throw APIError.fromStatus('INTERNAL_SERVER_ERROR', { message: 'Не удалось загрузить пользователя' });
  }

  await syncStorageProfile(storageKey, {
    username: refreshedUser.username,
    name: refreshedUser.name,
    image: refreshedUser.image,
    telegramUser,
  });

  return { user: refreshedUser, storageKey };
}

const telegramBodySchema = z.object({
  initData: z.string().min(1),
  rememberMe: z.boolean().optional(),
});

const registerBodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  username: z.string().min(1),
  name: z.string().trim().optional(),
  rememberMe: z.boolean().optional(),
});

const completeMigrationBodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  username: z.string().min(1),
  name: z.string().trim().optional(),
});

const usernameBodySchema = z.object({
  username: z.string().min(1),
});

function telegramPlugin() {
  return {
    id: 'telegram',
    endpoints: {
      telegramSignIn: createAuthEndpoint('/telegram/sign-in', {
        method: 'POST',
        body: telegramBodySchema,
      }, async (ctx) => {
        await ensureAuthDatabaseSchema();
        const telegramUser = parseTelegramUserOrThrow(ctx.body.initData);
        const telegramAccountId = String(telegramUser.id);
        const placeholderEmail = createPlaceholderEmail(telegramUser.id);
        const displayName = getTelegramDisplayName(telegramUser);
        const rememberMe = ctx.body.rememberMe !== false;

        let userId = await getUserIdByProviderAccount(telegramAccountId, TELEGRAM_PROVIDER_ID);

        if (!userId) {
          const placeholderUser = await getUserByEmail(placeholderEmail);
          if (placeholderUser) {
            userId = placeholderUser.id;
          } else {
            const client = await getAuthPool().connect();
            try {
              await client.query('BEGIN');
              userId = randomUUID();
              await client.query(
                `
                  INSERT INTO "user" (
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
                  )
                  VALUES ($1, $2, $3, FALSE, $4, NOW(), NOW(), NULL, NULL, FALSE)
                `,
                [userId, displayName, placeholderEmail, telegramUser.photo_url ?? null],
              );
              await linkTelegramAccountTx(client, userId, telegramUser.id);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          }
        } else {
          const client = await getAuthPool().connect();
          try {
            await client.query('BEGIN');
            await linkTelegramAccountTx(client, userId, telegramUser.id);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }

        const { user, storageKey } = await ensureTelegramStateForUser(userId, telegramUser);
        const accounts = await getAccountsForUser(user.id);
        const completionRequired = needsCompletion(user, accounts);

        if (user.migrationCompleted === completionRequired) {
          const client = await getAuthPool().connect();
          try {
            await client.query('BEGIN');
            await updateMigrationCompletedTx(client, user.id, !completionRequired);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }

        const refreshedUser = await getUserById(user.id);
        if (!refreshedUser) {
          throw APIError.fromStatus('INTERNAL_SERVER_ERROR', { message: 'Не удалось загрузить пользователя после миграции' });
        }

        const session = await ctx.context.internalAdapter.createSession(refreshedUser.id, !rememberMe);
        if (!session) {
          throw APIError.fromStatus('INTERNAL_SERVER_ERROR', { message: 'Не удалось создать сессию' });
        }

        await setSessionCookie(ctx, {
          session,
          user: refreshedUser,
        }, !rememberMe);

        return ctx.json({
          token: session.token,
          user: parseUserOutput(ctx.context.options, refreshedUser),
          storageKey,
          needsCompletion: needsCompletion(refreshedUser, accounts),
        });
      }),

      telegramLink: createAuthEndpoint('/telegram/link', {
        method: 'POST',
        body: telegramBodySchema,
        use: [sessionMiddleware],
      }, async (ctx) => {
        await ensureAuthDatabaseSchema();
        const telegramUser = parseTelegramUserOrThrow(ctx.body.initData);
        const sessionUser = ctx.context.session.user as AuthUserRecord;

        await assertNoStorageConflictForTelegramLink(sessionUser.id, telegramUser.id);

        const client = await getAuthPool().connect();
        try {
          await client.query('BEGIN');
          await linkTelegramAccountTx(client, sessionUser.id, telegramUser.id);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

        const { user, storageKey } = await ensureTelegramStateForUser(sessionUser.id, telegramUser);
        const accounts = await getAccountsForUser(user.id);
        const completionRequired = needsCompletion(user, accounts);

        if (user.migrationCompleted === completionRequired) {
          const updateClient = await getAuthPool().connect();
          try {
            await updateClient.query('BEGIN');
            await updateMigrationCompletedTx(updateClient, user.id, !completionRequired);
            await updateClient.query('COMMIT');
          } catch (error) {
            await updateClient.query('ROLLBACK');
            throw error;
          } finally {
            updateClient.release();
          }
        }

        return ctx.json({
          linked: true,
          storageKey,
          needsCompletion: completionRequired,
          user: parseUserOutput(ctx.context.options, user),
        });
      }),

      registerEmail: createAuthEndpoint('/register/email', {
        method: 'POST',
        body: registerBodySchema,
      }, async (ctx) => {
        await ensureAuthDatabaseSchema();
        const email = validateEmailAddress(ctx.body.email);
        const username = validateCanonicalUsername(ctx.body.username);
        const password = ctx.body.password;
        const name = ctx.body.name?.trim() || email.split('@')[0] || 'Athlete';
        const rememberMe = ctx.body.rememberMe !== false;

        ensurePasswordLength(
          password,
          ctx.context.password.config.minPasswordLength,
          ctx.context.password.config.maxPasswordLength,
        );

        if (await getUserByEmail(email)) {
          throw APIError.fromStatus('BAD_REQUEST', { message: 'Пользователь с таким email уже существует' });
        }

        if (!(await AuthMetaService.isAliasAvailable(username))) {
          throw APIError.fromStatus('BAD_REQUEST', { message: 'Username already taken' });
        }

        const passwordHash = await ctx.context.password.hash(password);
        const userId = randomUUID();

        const client = await getAuthPool().connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `
              INSERT INTO "user" (
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
              )
              VALUES ($1, $2, $3, FALSE, NULL, NOW(), NOW(), $4, $5, TRUE)
            `,
            [userId, name, email, username, username],
          );
          await linkCredentialPasswordTx(client, userId, passwordHash);
          await setCanonicalUsernameTx(client, userId, username);
          await upsertStorageBindingTx(client, userId, `u_${userId}`);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

        const user = await getUserById(userId);
        if (!user) {
          throw APIError.fromStatus('INTERNAL_SERVER_ERROR', { message: 'Не удалось загрузить пользователя' });
        }

        const storageKey = await AuthMetaService.ensureStorageBinding(user.id, () => `u_${user.id}`);
        await syncStorageProfile(storageKey, {
          username: user.username,
          name: user.name,
          image: user.image,
        });

        const session = await ctx.context.internalAdapter.createSession(user.id, !rememberMe);
        if (!session) {
          throw APIError.fromStatus('INTERNAL_SERVER_ERROR', { message: 'Не удалось создать сессию' });
        }

        await setSessionCookie(ctx, {
          session,
          user,
        }, !rememberMe);

        return ctx.json({
          token: session.token,
          user: parseUserOutput(ctx.context.options, user),
          needsCompletion: false,
        });
      }),

      migrationStatus: createAuthEndpoint('/migration/status', {
        method: 'GET',
        use: [sessionMiddleware],
      }, async (ctx) => {
        await ensureAuthDatabaseSchema();
        const sessionUser = ctx.context.session.user as AuthUserRecord;
        const user = await getUserById(sessionUser.id);
        if (!user) {
          throw APIError.fromStatus('NOT_FOUND', { message: 'User not found' });
        }

        const accounts = await getAccountsForUser(user.id);
        const hasPassword = accounts.some((account) => account.providerId === 'credential' && Boolean(account.password));
        const telegramAccount = accounts.find((account) => account.providerId === TELEGRAM_PROVIDER_ID);
        const storageKey = await AuthMetaService.getStorageKeyForUser(user.id);
        const passkeyCount = await getPasskeyCount(user.id);
        const canonicalAlias = await getCanonicalAlias(user.id);
        const suggestedUsername = await getSuggestedUsername(user.id, telegramAccount ? Number(telegramAccount.accountId) : undefined);

        return ctx.json({
          user: parseUserOutput(ctx.context.options, user),
          storageKey,
          canonicalAlias,
          suggestedUsername,
          hasPassword,
          hasPasskey: passkeyCount > 0,
          hasTelegram: Boolean(telegramAccount),
          emailIsPlaceholder: isPlaceholderEmail(user.email),
          needsCompletion: needsCompletion(user, accounts),
          linkedProviders: accounts.map((account) => account.providerId),
          telegramUserId: telegramAccount?.accountId ?? null,
        });
      }),

      completeMigration: createAuthEndpoint('/migration/complete', {
        method: 'POST',
        body: completeMigrationBodySchema,
        use: [sessionMiddleware],
      }, async (ctx) => {
        await ensureAuthDatabaseSchema();
        const sessionUser = ctx.context.session.user as AuthUserRecord;
        const user = await getUserById(sessionUser.id);
        if (!user) {
          throw APIError.fromStatus('NOT_FOUND', { message: 'User not found' });
        }

        const email = validateEmailAddress(ctx.body.email);
        const username = validateCanonicalUsername(ctx.body.username);
        const password = ctx.body.password;
        const name = ctx.body.name?.trim() || user.name;

        ensurePasswordLength(
          password,
          ctx.context.password.config.minPasswordLength,
          ctx.context.password.config.maxPasswordLength,
        );

        const existingUserWithEmail = await getUserByEmail(email);
        if (existingUserWithEmail && existingUserWithEmail.id !== user.id) {
          throw APIError.fromStatus('BAD_REQUEST', { message: 'Этот email уже используется' });
        }

        if (!(await AuthMetaService.isAliasAvailable(username, user.id))) {
          throw APIError.fromStatus('BAD_REQUEST', { message: 'Username already taken' });
        }

        const passwordHash = await ctx.context.password.hash(password);

        const client = await getAuthPool().connect();
        try {
          await client.query('BEGIN');
          await setCanonicalUsernameTx(client, user.id, username);
          await updateUserProfileTx(client, user.id, {
            email,
            name,
            migrationCompleted: true,
          });
          await linkCredentialPasswordTx(client, user.id, passwordHash);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

        const refreshedUser = await getUserById(user.id);
        if (!refreshedUser) {
          throw APIError.fromStatus('INTERNAL_SERVER_ERROR', { message: 'Не удалось обновить пользователя' });
        }

        const storageKey = await AuthMetaService.ensureStorageBinding(refreshedUser.id, () => `u_${refreshedUser.id}`);
        await syncStorageProfile(storageKey, {
          username: refreshedUser.username,
          name: refreshedUser.name,
          image: refreshedUser.image,
        });

        await setSessionCookie(ctx, {
          session: ctx.context.session.session,
          user: refreshedUser,
        });

        return ctx.json({
          completed: true,
          user: parseUserOutput(ctx.context.options, refreshedUser),
          storageKey,
          needsCompletion: false,
        });
      }),

      checkUsername: createAuthEndpoint('/username/check', {
        method: 'POST',
        body: usernameBodySchema,
      }, async (ctx) => {
        await ensureAuthDatabaseSchema();
        const username = validateCanonicalUsername(ctx.body.username);
        const available = await AuthMetaService.isAliasAvailable(username);
        return ctx.json({ username, available });
      }),
    },
  };
}

function createAuthInstance() {
  return betterAuth({
    appName: config.PASSKEY_RP_NAME,
    baseURL: config.AUTH_ORIGIN,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins,
    database: getAuthPool(),
    emailAndPassword: {
      enabled: true,
    },
    user: {
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {
        username: {
          type: 'string',
          required: false,
          unique: true,
          returned: true,
        },
        displayUsername: {
          type: 'string',
          required: false,
          returned: true,
          fieldName: 'display_username',
        },
        migrationCompleted: {
          type: 'boolean',
          required: false,
          returned: true,
          input: false,
          defaultValue: false,
          fieldName: 'migration_completed',
        },
      },
    },
    session: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
      cookieCache: {
        enabled: true,
        strategy: 'jwe',
        refreshCache: true,
        maxAge: 300,
      },
    },
    account: {
      storeStateStrategy: 'cookie',
      storeAccountCookie: true,
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    plugins: [
      bearer(),
      passkey({
        rpID: config.PASSKEY_RP_ID,
        rpName: config.PASSKEY_RP_NAME,
        origin: trustedOrigins,
        schema: {
          passkey: {
            fields: {
              publicKey: 'public_key',
              userId: 'user_id',
              credentialID: 'credential_id',
              deviceType: 'device_type',
              backedUp: 'backed_up',
              createdAt: 'created_at',
            },
          },
        },
      }),
      telegramPlugin(),
    ],
  });
}

let authInstance: ReturnType<typeof createAuthInstance> | null = null;
let authNodeHandler: ReturnType<typeof toNodeHandler> | null = null;

export function getAuth() {
  if (!authInstance) {
    authInstance = createAuthInstance();
  }

  return authInstance;
}

export async function ensureAuthReady() {
  if (!HAS_DATABASE) {
    return;
  }

  await ensureAuthDatabaseSchema();
}

export function createAuthNodeHandler() {
  if (!authNodeHandler) {
    authNodeHandler = toNodeHandler(getAuth());
  }

  return authNodeHandler;
}

export async function resolveBetterAuthSession(headers: Headers): Promise<{ session: Record<string, unknown>; user: AuthUserRecord } | null> {
  if (!HAS_DATABASE) {
    return null;
  }

  if (!headers.get('authorization') && !headers.get('cookie')) {
    return null;
  }

  await ensureAuthReady();

  const payload = await getAuth().api.getSession({
    headers,
    query: {
      disableRefresh: true,
    },
  }).catch(() => null) as {
    session?: Record<string, unknown>;
    user?: AuthUserRecord;
  } | null;

  if (!payload?.session || !payload.user?.id) {
    return null;
  }

  const user = await getUserById(payload.user.id);
  if (!user) {
    return null;
  }

  return {
    session: payload.session,
    user,
  };
}

export async function resolveRequestContext(headers: Headers): Promise<AuthenticatedRequestContext | null> {
  const betterSession = await resolveBetterAuthSession(headers);
  if (betterSession) {
    const storageKey = await AuthMetaService.ensureStorageBinding(betterSession.user.id, () => `u_${betterSession.user.id}`);
    return {
      kind: 'better-auth',
      storageKey,
      authUser: betterSession.user,
    };
  }

  const initData = headers.get('x-telegram-init-data');
  if (!initData || !validateTelegramInitData(initData)) {
    return null;
  }

  const { user: telegramUser } = parseTelegramInitData(initData);
  if (!telegramUser?.id) {
    return null;
  }

  if (!HAS_DATABASE) {
    return {
      kind: 'telegram-legacy',
      storageKey: String(telegramUser.id),
      telegramUser,
    };
  }

  const linkedUserId = await getUserIdByProviderAccount(String(telegramUser.id), TELEGRAM_PROVIDER_ID);
  const authUser = linkedUserId ? await getUserById(linkedUserId) : null;
  const storageKey = authUser
    ? await AuthMetaService.ensureStorageBinding(authUser.id, () => String(telegramUser.id))
    : String(telegramUser.id);

  return {
    kind: 'telegram-legacy',
    storageKey,
    authUser: authUser ?? undefined,
    telegramUser,
  };
}

export async function closeAuthResources() {
  authNodeHandler = null;
  authInstance = null;
  await closeAuthPool();
}
