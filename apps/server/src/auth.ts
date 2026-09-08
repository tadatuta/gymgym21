import {
  getUserById,
  getUserByEmail,
  getAccountsForUser,
  getUserIdByProviderAccount,
  getCanonicalAlias,
  getPasskeyCount,
  claimUserAliasTx,
  AliasOwnershipError,
  setCanonicalAliasTx,
  upsertStorageBindingTx,
  ensureStorageBindingTx,
  linkProviderAccountTx,
  type AuthUserRecord,
  type AccountRecord,
} from './auth-identity.js';
export type { AuthUserRecord } from './auth-identity.js';
import { randomUUID } from 'node:crypto';
import { betterAuth, APIError } from 'better-auth';
import { createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from 'better-auth/api';
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
  connectIdentityClient,
  closeAuthPool,
  createPlaceholderEmail,
  ensureAuthDatabaseSchema,
  getAuthPool,
  isPlaceholderEmail,
  isValidUsername,
  normalizeUsername,
} from './auth-meta.js';
import { defaultStorageRepository } from './storage.js';
import { extractTelegramUser, parseTelegramInitData, type TelegramUser, validateTelegramInitData } from './telegram.js';

const TELEGRAM_PROVIDER_ID = 'telegram';

export interface AuthenticatedRequestContext {
  kind: 'better-auth' | 'telegram';
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

function getTelegramDisplayName(telegramUser: TelegramUser): string {
  const fullName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').trim();
  return fullName || telegramUser.username || `Telegram ${telegramUser.id}`;
}

function validateEmailAddress(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!z.email().safeParse(normalized).success || isPlaceholderEmail(normalized)) {
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
  const user = extractTelegramUser(initData);
  if (!user?.id) {
    throw APIError.fromStatus('BAD_REQUEST', { message: 'Не удалось определить пользователя Telegram' });
  }
  return user;
}

export async function upsertAliasTx(client: PoolClient, userId: string, alias: string, type: 'canonical' | 'telegram_username' | 'telegram_id') {
  const normalizedAlias = alias.trim().replace(/^@/, '').toLowerCase();
  if (!normalizedAlias) return;

  try {
    await claimUserAliasTx(client, userId, normalizedAlias, type);
  } catch (error) {
    if (error instanceof AliasOwnershipError) {
      throw APIError.fromStatus('BAD_REQUEST', { message: `Identifier already taken: ${normalizedAlias}` });
    }
    throw error;
  }
}

async function tryUpsertAliasTx(client: PoolClient, userId: string, alias: string | undefined, type: 'telegram_username') {
  if (!alias) return;
  const normalizedAlias = normalizeUsername(alias);
  if (!isValidUsername(normalizedAlias)) return;
  try {
    await claimUserAliasTx(client, userId, normalizedAlias, type);
  } catch (error) {
    if (!(error instanceof AliasOwnershipError)) throw error;
    // Keep auth linking flowing even if a secondary alias is already occupied.
  }
}

async function setCanonicalUsernameTx(client: PoolClient, userId: string, username: string) {
  try {
    await setCanonicalAliasTx(client, userId, validateCanonicalUsername(username));
  } catch (error) {
    if (error instanceof AliasOwnershipError) throw APIError.fromStatus('BAD_REQUEST', { message: 'Username already taken' });
    throw error;
  }
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
  if (!(await linkProviderAccountTx(client, userId, accountId, TELEGRAM_PROVIDER_ID))) {
    throw APIError.fromStatus('BAD_REQUEST', { message: 'Этот Telegram уже привязан к другому аккаунту' });
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
  await defaultStorageRepository.updateProfileFromAuth(storageKey, data);
}

function needsCompletion(user: AuthUserRecord, accounts: AccountRecord[]): boolean {
  const hasPassword = accounts.some((account) => account.providerId === 'credential' && Boolean(account.password));
  return !user.username || isPlaceholderEmail(user.email) || !hasPassword || !user.migrationCompleted;
}

async function getSuggestedUsername(userId: string, telegramUserId?: number): Promise<string | null> {
  const user = await getUserById(getAuthPool(), userId);
  if (user?.username) {
    return user.username;
  }

  const candidates = telegramUserId ? [`user${telegramUserId}`] : [];

  for (const candidate of candidates) {
    const normalized = normalizeUsername(candidate);
    if (isValidUsername(normalized) && (await AuthMetaService.isAliasAvailable(normalized, userId))) {
      return normalized;
    }
  }

  return null;
}

async function ensureTelegramStateTx(client: PoolClient, userId: string, telegramUser: TelegramUser): Promise<{ user: AuthUserRecord; storageKey: string }> {
  const preferredUsername = [telegramUser.username]
    .map((value) => value ? normalizeUsername(value) : null)
    .find((value): value is string => Boolean(value && isValidUsername(value)));
  const storageKey = await ensureStorageBindingTx(client, userId, `u_${userId}`);
  await client.query(
    "UPDATE account SET telegram_username = $3, updated_at = NOW() WHERE user_id = $1 AND provider_id = 'telegram' AND account_id = $2",
    [userId, String(telegramUser.id), telegramUser.username ?? null],
  );
  await upsertAliasTx(client, userId, `id_${telegramUser.id}`, 'telegram_id');

  const currentUser = await getUserById(client, userId);
  let currentCanonical = currentUser?.username ?? null;

  if (!currentCanonical && preferredUsername) {
    try {
      await setCanonicalAliasTx(client, userId, preferredUsername);
      currentCanonical = preferredUsername;
    }
    catch (error) { if (!(error instanceof AliasOwnershipError)) throw error; }
  }

  if (telegramUser.username) {
    const normalizedTelegramUsername = normalizeUsername(telegramUser.username);
    if ((!currentCanonical || currentCanonical !== normalizedTelegramUsername) && isValidUsername(normalizedTelegramUsername)) {
      await tryUpsertAliasTx(client, userId, normalizedTelegramUsername, 'telegram_username');
    }
  }

  const refreshedUser = await getUserById(client, userId);
  if (!refreshedUser) {
    throw APIError.fromStatus('INTERNAL_SERVER_ERROR', { message: 'Не удалось загрузить пользователя' });
  }

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

        let telegramState: { user: AuthUserRecord; storageKey: string };
        let userId = await getUserIdByProviderAccount(getAuthPool(), telegramAccountId, TELEGRAM_PROVIDER_ID);

        if (!userId) {
          const client = await connectIdentityClient();
          try {
            await client.query('BEGIN');
            userId = randomUUID();
            const inserted = await client.query(
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
                ON CONFLICT (email) DO NOTHING RETURNING id
              `,
              [userId, displayName, placeholderEmail, telegramUser.photo_url ?? null],
            );
            if (!inserted.rowCount) {
              // A concurrent first login may have committed the provider binding.
              // Only that binding proves identity; the email owner never does.
              const linked = await client.query<{ user_id: string }>(
                'SELECT user_id FROM account WHERE provider_id = $1 AND account_id = $2',
                [TELEGRAM_PROVIDER_ID, telegramAccountId],
              );
              if (!linked.rows[0]) {
                console.warn('[auth] Telegram sign-in blocked: reserved email collision');
                throw APIError.fromStatus('CONFLICT', {
                  code: 'TELEGRAM_IDENTITY_CONFLICT',
                  message: 'Технический адрес занят аккаунтом без привязки Telegram. Войдите прежним способом, укажите обычный email и привяжите Telegram в настройках. Если вход недоступен, обратитесь в поддержку; данные сохранены.',
                });
              }
              userId = linked.rows[0].user_id;
            }
            await linkTelegramAccountTx(client, userId, telegramUser.id);
            telegramState = await ensureTelegramStateTx(client, userId, telegramUser);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        } else {
          const client = await connectIdentityClient();
          try {
            await client.query('BEGIN');
            await linkTelegramAccountTx(client, userId, telegramUser.id);
            telegramState = await ensureTelegramStateTx(client, userId, telegramUser);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }

        const { user, storageKey } = telegramState;
        await syncStorageProfile(storageKey, { username: user.username, name: user.name, image: user.image, telegramUser });
        const accounts = await getAccountsForUser(getAuthPool(), user.id);
        const completionRequired = needsCompletion(user, accounts);

        if (user.migrationCompleted === completionRequired) {
          const client = await connectIdentityClient();
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

        const refreshedUser = await getUserById(getAuthPool(), user.id);
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

        let telegramState: { user: AuthUserRecord; storageKey: string };
        const client = await connectIdentityClient();
        try {
          await client.query('BEGIN');
          await linkTelegramAccountTx(client, sessionUser.id, telegramUser.id);
          telegramState = await ensureTelegramStateTx(client, sessionUser.id, telegramUser);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

        const { user, storageKey } = telegramState;
        await syncStorageProfile(storageKey, { username: user.username, name: user.name, image: user.image, telegramUser });
        const accounts = await getAccountsForUser(getAuthPool(), user.id);
        const completionRequired = needsCompletion(user, accounts);

        if (user.migrationCompleted === completionRequired) {
          const updateClient = await connectIdentityClient();
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

        if (await getUserByEmail(getAuthPool(), email)) {
          throw APIError.fromStatus('BAD_REQUEST', { message: 'Пользователь с таким email уже существует' });
        }

        if (!(await AuthMetaService.isAliasAvailable(username))) {
          throw APIError.fromStatus('BAD_REQUEST', { message: 'Username already taken' });
        }

        const passwordHash = await ctx.context.password.hash(password);
        const userId = randomUUID();

        const client = await connectIdentityClient();
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
          // The availability reads above are advisory: a concurrent registration
          // can commit before this transaction reaches the unique constraints.
          if (error instanceof Error && 'code' in error && error.code === '23505'
            && 'table' in error && error.table === 'user' && 'constraint' in error) {
            if (error.constraint === 'user_email_key') {
              throw APIError.fromStatus('BAD_REQUEST', { message: 'Пользователь с таким email уже существует' });
            }
            if (error.constraint === 'user_username_key') {
              throw APIError.fromStatus('BAD_REQUEST', { message: 'Username already taken' });
            }
          }
          throw error;
        } finally {
          client.release();
        }

        const user = await getUserById(getAuthPool(), userId);
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
        const user = await getUserById(getAuthPool(), sessionUser.id);
        if (!user) {
          throw APIError.fromStatus('NOT_FOUND', { message: 'User not found' });
        }

        const accounts = await getAccountsForUser(getAuthPool(), user.id);
        const hasPassword = accounts.some((account) => account.providerId === 'credential' && Boolean(account.password));
        const telegramAccount = accounts.find((account) => account.providerId === TELEGRAM_PROVIDER_ID);
        const storageKey = await AuthMetaService.getStorageKeyForUser(user.id);
        const passkeyCount = await getPasskeyCount(getAuthPool(), user.id);
        const canonicalAlias = await getCanonicalAlias(getAuthPool(), user.id);
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
        const user = await getUserById(getAuthPool(), sessionUser.id);
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

        const existingUserWithEmail = await getUserByEmail(getAuthPool(), email);
        if (existingUserWithEmail && existingUserWithEmail.id !== user.id) {
          throw APIError.fromStatus('BAD_REQUEST', { message: 'Этот email уже используется' });
        }

        if (!(await AuthMetaService.isAliasAvailable(username, user.id))) {
          throw APIError.fromStatus('BAD_REQUEST', { message: 'Username already taken' });
        }

        const passwordHash = await ctx.context.password.hash(password);

        const client = await connectIdentityClient();
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

        const refreshedUser = await getUserById(getAuthPool(), user.id);
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
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Cover the provider's built-in write endpoints as well as our own validators.
        const email = ctx.path === '/change-email' ? ctx.body?.newEmail
          : ['/sign-up/email', '/update-user'].includes(ctx.path) ? ctx.body?.email : undefined;
        if (typeof email === 'string') validateEmailAddress(email);
      }),
    },
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

let authPool: ReturnType<typeof getAuthPool> | null = null;
let authInstance: ReturnType<typeof createAuthInstance> | null = null;
let authNodeHandler: ReturnType<typeof toNodeHandler> | null = null;

export function getAuth() {
  const currentPool = getAuthPool();
  if (!authInstance || authPool !== currentPool) {
    authInstance = createAuthInstance();
    authPool = currentPool;
    authNodeHandler = null;
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
  const auth = getAuth();
  if (!authNodeHandler) {
    authNodeHandler = toNodeHandler(auth);
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

  const user = await getUserById(getAuthPool(), payload.user.id);
  if (!user) {
    return null;
  }

  return {
    session: payload.session,
    user,
  };
}

async function getLinkedTelegramUser(user: AuthUserRecord): Promise<TelegramUser | undefined> {
  const accounts = await getAccountsForUser(getAuthPool(), user.id);
  const account = accounts.find((entry) => entry.providerId === TELEGRAM_PROVIDER_ID);
  return account ? { id: Number(account.accountId), first_name: user.name, username: account.telegramUsername ?? undefined } : undefined;
}

export async function resolveRequestContext(headers: Headers): Promise<AuthenticatedRequestContext | null> {
  if (!HAS_DATABASE) {
    return null;
  }

  const betterSession = await resolveBetterAuthSession(headers);
  if (betterSession) {
    const storageKey = await AuthMetaService.ensureStorageBinding(betterSession.user.id, () => `u_${betterSession.user.id}`);
    const telegramUser = await getLinkedTelegramUser(betterSession.user);
    return {
      kind: 'better-auth',
      telegramUser,
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

  await ensureAuthReady();
  const linkedUserId = await getUserIdByProviderAccount(getAuthPool(), String(telegramUser.id), TELEGRAM_PROVIDER_ID);
  const authUser = linkedUserId ? await getUserById(getAuthPool(), linkedUserId) : null;
  const storageKey = authUser
    ? await AuthMetaService.ensureStorageBinding(authUser.id, () => `u_${authUser.id}`)
    : `telegram_${telegramUser.id}`;

  return {
    kind: 'telegram',
    storageKey,
    authUser: authUser ?? undefined,
    telegramUser,
  };
}

export async function closeAuthResources() {
  authPool = null;
  authNodeHandler = null;
  authInstance = null;
  await closeAuthPool();
}
