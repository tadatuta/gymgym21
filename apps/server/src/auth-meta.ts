import type { PoolClient } from 'pg';
import { ensureDatabaseReady, getDatabasePool, closeDatabasePool } from './database.js';
import { config } from './config.js';

import { normalizeIdentifier, claimUserAliasTx, setCanonicalAliasTx, ensureStorageBindingTx, type AliasType } from './auth-identity.js';
export { normalizeIdentifier, normalizeUsername, isValidUsername, claimUserAliasTx, type AliasType } from './auth-identity.js';

export interface AliasRecord {
    alias: string;
    type: AliasType;
    userId: string;
    storageKey: string | null;
}

// Compatibility names share the versioned schema runner and pool lifecycle.
export const getAuthPool = getDatabasePool;
export const ensureAuthDatabaseSchema = ensureDatabaseReady;
export const closeAuthPool = closeDatabasePool;

export function createPlaceholderEmail(telegramUserId: number): string {
    return `telegram-${telegramUserId}@${config.TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email: string): boolean {
    return email.trim().toLowerCase().endsWith(`@${config.TELEGRAM_PLACEHOLDER_EMAIL_DOMAIN.toLowerCase()}`);
}

/** Prepare both registries before acquiring a transaction client; helpers never run DDL. */
export async function connectIdentityClient(): Promise<PoolClient> {
    await ensureDatabaseReady();
    return getAuthPool().connect();
}

export async function withIdentityTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await connectIdentityClient();
    try {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
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

    static async ensureStorageBinding(userId: string, storageKeyFactory?: () => string): Promise<string> {
        return withIdentityTransaction(client => ensureStorageBindingTx(client, userId, storageKeyFactory ? storageKeyFactory() : `u_${userId}`));
    }

    static async getAlias(alias: string, client?: PoolClient): Promise<AliasRecord | null> {
        if (!client) await ensureAuthDatabaseSchema();
        const aliasLower = normalizeIdentifier(alias);
        const result = await (client ?? getAuthPool()).query<{
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
        await withIdentityTransaction(client => claimUserAliasTx(client, userId, alias, type));
    }

    static async setCanonicalAlias(userId: string, username: string): Promise<void> {
        await withIdentityTransaction(client => setCanonicalAliasTx(client, userId, username));
    }
}
