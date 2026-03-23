import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { config } from './config.js';

export type AliasType = 'canonical' | 'telegram_username' | 'telegram_id' | 'legacy_username';

export interface AliasRecord {
    alias: string;
    type: AliasType;
    userId: string;
    storageKey: string | null;
}

let pool: Pool | null = null;
let schemaPromise: Promise<void> | null = null;

const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    image TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    username TEXT UNIQUE,
    display_username TEXT,
    migration_completed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address TEXT,
    user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_id_idx ON "session"(user_id);

CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope TEXT,
    password TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT account_provider_account_unique UNIQUE (provider_id, account_id)
);
CREATE INDEX IF NOT EXISTS account_user_id_idx ON account(user_id);

CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);

CREATE TABLE IF NOT EXISTS passkey (
    id TEXT PRIMARY KEY,
    name TEXT,
    public_key TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    counter INTEGER NOT NULL,
    device_type TEXT NOT NULL,
    backed_up BOOLEAN NOT NULL,
    transports TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    aaguid TEXT
);
CREATE INDEX IF NOT EXISTS passkey_user_id_idx ON passkey(user_id);
CREATE INDEX IF NOT EXISTS passkey_credential_id_idx ON passkey(credential_id);

CREATE TABLE IF NOT EXISTS user_storage_binding (
    user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_alias (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    alias_lower TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_alias_user_id_idx ON user_alias(user_id);
`;

function assertDatabaseUrl() {
    if (!config.DATABASE_URL) {
        throw new Error('DATABASE_URL is required for Better Auth');
    }
}

export function getAuthPool(): Pool {
    if (!pool) {
        assertDatabaseUrl();
        pool = new Pool({
            connectionString: config.DATABASE_URL,
            ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
        });
    }
    return pool;
}

export async function ensureAuthDatabaseSchema() {
    if (!schemaPromise) {
        const currentPool = getAuthPool();
        schemaPromise = currentPool.query(AUTH_SCHEMA_SQL).then(() => undefined);
    }
    return schemaPromise;
}

export async function closeAuthPool() {
    if (!pool) return;
    const currentPool = pool;
    pool = null;
    schemaPromise = null;
    await currentPool.end();
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

export function createPlaceholderEmail(telegramUserId: number): string {
    return `telegram-${telegramUserId}@${config.TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email: string): boolean {
    return email.toLowerCase().endsWith(`@${config.TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN}`);
}

export class AuthMetaService {
    static async getStorageKeyForUser(userId: string): Promise<string | null> {
        await ensureAuthDatabaseSchema();
        const result = await getAuthPool().query<{ storage_key: string }>(
            'SELECT storage_key FROM user_storage_binding WHERE user_id = $1',
            [userId],
        );
        return result.rows[0]?.storage_key ?? null;
    }

    static async upsertStorageBinding(userId: string, storageKey: string): Promise<string> {
        await ensureAuthDatabaseSchema();
        await getAuthPool().query(
            `
                INSERT INTO user_storage_binding (user_id, storage_key, created_at, updated_at)
                VALUES ($1, $2, NOW(), NOW())
                ON CONFLICT (user_id)
                DO UPDATE SET storage_key = EXCLUDED.storage_key, updated_at = NOW()
            `,
            [userId, storageKey],
        );
        return storageKey;
    }

    static async ensureStorageBinding(userId: string, storageKeyFactory?: () => string): Promise<string> {
        const existing = await this.getStorageKeyForUser(userId);
        if (existing) return existing;
        const storageKey = storageKeyFactory ? storageKeyFactory() : `u_${userId}`;
        return this.upsertStorageBinding(userId, storageKey);
    }

    static async getAlias(alias: string): Promise<AliasRecord | null> {
        await ensureAuthDatabaseSchema();
        const aliasLower = normalizeIdentifier(alias);
        const result = await getAuthPool().query<{
            alias: string;
            type: AliasType;
            user_id: string;
            storage_key: string | null;
        }>(
            `
                SELECT ua.alias, ua.type, ua.user_id, usb.storage_key
                FROM user_alias ua
                LEFT JOIN user_storage_binding usb ON usb.user_id = ua.user_id
                WHERE ua.alias_lower = $1
            `,
            [aliasLower],
        );

        const row = result.rows[0];
        if (!row) return null;

        return {
            alias: row.alias,
            type: row.type,
            userId: row.user_id,
            storageKey: row.storage_key,
        };
    }

    static async isAliasAvailable(alias: string, userId?: string): Promise<boolean> {
        const existing = await this.getAlias(alias);
        return !existing || existing.userId === userId;
    }

    static async claimAlias(userId: string, alias: string, type: AliasType): Promise<void> {
        await ensureAuthDatabaseSchema();
        const normalizedAlias = alias.trim();
        const aliasLower = normalizeIdentifier(normalizedAlias);
        const existing = await this.getAlias(aliasLower);

        if (existing && existing.userId !== userId) {
            throw new Error(`Alias already taken: ${normalizedAlias}`);
        }

        await getAuthPool().query(
            `
                INSERT INTO user_alias (id, user_id, alias, alias_lower, type, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                ON CONFLICT (alias_lower)
                DO UPDATE SET user_id = EXCLUDED.user_id, alias = EXCLUDED.alias, type = EXCLUDED.type, updated_at = NOW()
            `,
            [randomUUID(), userId, normalizedAlias, aliasLower, type],
        );
    }

    static async tryClaimAlias(userId: string, alias: string, type: AliasType): Promise<boolean> {
        try {
            await this.claimAlias(userId, alias, type);
            return true;
        } catch {
            return false;
        }
    }

    static async setCanonicalAlias(userId: string, username: string): Promise<void> {
        const normalizedUsername = normalizeUsername(username);
        if (!isValidUsername(normalizedUsername)) {
            throw new Error('Invalid username');
        }

        const client = await getAuthPool().connect();
        try {
            await client.query('BEGIN');
            const existing = await client.query<{ user_id: string }>(
                'SELECT user_id FROM user_alias WHERE alias_lower = $1 LIMIT 1',
                [normalizedUsername],
            );
            if (existing.rows[0] && existing.rows[0].user_id !== userId) {
                throw new Error('Username already taken');
            }

            await client.query(
                'DELETE FROM user_alias WHERE user_id = $1 AND type = $2 AND alias_lower <> $3',
                [userId, 'canonical', normalizedUsername],
            );
            await client.query(
                `
                    INSERT INTO user_alias (id, user_id, alias, alias_lower, type, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                    ON CONFLICT (alias_lower)
                    DO UPDATE SET user_id = EXCLUDED.user_id, alias = EXCLUDED.alias, type = EXCLUDED.type, updated_at = NOW()
                `,
                [randomUUID(), userId, normalizedUsername, normalizedUsername, 'canonical'],
            );
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    static async resolveStorageKeyByIdentifier(identifier: string): Promise<string | null> {
        const alias = await this.getAlias(identifier);
        return alias?.storageKey ?? null;
    }
}
