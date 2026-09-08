import { publicProfileSchema } from '@gym21/contracts';
import type { PublicProfileData } from '../types';
import { authorizedApiFetch, hasVerifiedOnlineAccount, resolveApiUrl } from '../auth';
import type { AccountRepository } from './account-repository';
import type { SyncCoordinator } from './sync-coordinator';
export interface CachedAiResults {
    general: string | null;
    plan: string | null;
}

type PublicProfileWithCacheMetadata = PublicProfileData & {
    cacheMetadata?: {
        cached: boolean;
        cachedAt: string;
    };
};

export class PublicHistoryStaleError extends Error {
    constructor() { super('История изменилась. Обновите профиль, чтобы продолжить.'); }
}

export class PublicProfileUnavailableError extends Error {
    constructor() { super('Не удалось загрузить профиль. Проверьте подключение и попробуйте ещё раз.'); }
}

export async function getPublicProfile(identifier: string, repository?: AccountRepository, cursor?: string): Promise<PublicProfileWithCacheMetadata | null> {
    const context = repository?.context;
    context?.assertCurrent();
    const db = repository?.database;
    const normalizedIdentifier = identifier.trim().replace(/^@/, '').toLowerCase();
    if (!normalizedIdentifier) return null;

    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (context) context.signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 10000);
    try {
        const response = await fetch(resolveApiUrl(`/profiles/${encodeURIComponent(identifier)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`), { signal: controller.signal });
        if (context) context.assertCurrent();
        if (response.ok) {
            const payload = publicProfileSchema.parse(await response.json());
            if (context) context.assertCurrent();
            const cachedAt = new Date().toISOString();
            if (!cursor && repository && db) await repository.transaction([db.publicProfileCache], () => db.publicProfileCache.put({
                identifier: normalizedIdentifier,
                payload,
                cachedAt,
            }));
            if (context) context.assertCurrent();
            return {
                ...payload,
                cacheMetadata: { cached: false, cachedAt },
            };
        }
        if (response.status === 404 || response.status === 403) {
            if (repository && db) await repository.transaction([db.publicProfileCache], () => db.publicProfileCache.delete(normalizedIdentifier));
            if (context) context.assertCurrent();
            return null;
        }
        if (response.status === 409) throw new PublicHistoryStaleError();
        throw new Error('Public profile request failed');
    } catch (error) {
        if (error instanceof PublicHistoryStaleError) throw error;
        if (cursor) throw new PublicProfileUnavailableError();
        // Fall through to the account-scoped IndexedDB cache.
    } finally {
        clearTimeout(timeout);
        context?.signal.removeEventListener('abort', cancel);
    }
    if (!db) throw new PublicProfileUnavailableError();

    if (context) context.assertCurrent();
    const cached = await db?.publicProfileCache.get(normalizedIdentifier);
    if (context) context.assertCurrent();
    return cached
        ? {
            ...cached.payload,
            cacheMetadata: { cached: true, cachedAt: cached.cachedAt },
        }
        : null;
}

export class RemoteReads {
    constructor(private readonly repository: AccountRepository, private readonly coordinator: SyncCoordinator) {}
    async readCachedAIResults(): Promise<CachedAiResults> {
        this.repository.context.assertCurrent();
        const records = await this.repository.database.aiResultCache.toArray();
        this.repository.context.assertCurrent();
        return {
            general: records.find((record) => record.type === 'general')?.markdown ?? null,
            plan: records.find((record) => record.type === 'plan')?.markdown ?? null,
        };
    }

    async getAIRecommendation(
        type: 'general' | 'plan',
        options?: { period?: 'day' | 'week'; allowNewExercises?: boolean },
    ): Promise<string> {
        const context = this.repository.context;
        const db = context.database;
        if (!hasVerifiedOnlineAccount(this.repository.context.storageKey)) {
            throw new Error('Новая рекомендация требует подключения к интернету');
        }

        this.repository.context.assertCurrent();
        // A successful fresh roundtrip is mandatory, including when the outbox starts empty.
        // A scheduler cooldown/failure/lock miss is not evidence that the server has this profile.
        let expectedRevision: number | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const result = await this.coordinator.sync();
            context.assertCurrent();
            if (!result) throw new Error('Не удалось синхронизировать данные для AI. Дождитесь синхронизации и повторите.');
            expectedRevision = await db.transaction('r', [db.dirtyEntities, db.syncConflicts, db.syncState], async () => {
                context.assertCurrent();
                if (await db.syncConflicts.count()) throw new Error('Перед запросом AI разрешите конфликты синхронизации.');
                if (result.hasMore || await db.dirtyEntities.count()) return undefined;
                const state = await db.syncState.get('sync-cursor');
                context.assertCurrent();
                return state?.cursor === result.cursor ? state.cursor : undefined;
            });
            context.assertCurrent();
            if (expectedRevision !== undefined) break;
        }
        if (expectedRevision === undefined) throw new Error('Данные ещё синхронизируются. Повторите запрос AI позже.');
        context.assertCurrent();

        const response = await authorizedApiFetch('/me/ai/recommendations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, options, expectedRevision }),
        }, context);
        context.assertCurrent();
        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('Unauthorized');
            }
            const failure = await response.json().catch(() => null);
            context.assertCurrent();
            if (response.status === 409 && failure?.code === 'AI_CONTEXT_STALE') throw new Error('Данные на сервере изменились. Повторите запрос AI: данные синхронизируются заново.');
            if (failure?.code === 'AI_TIMEOUT') throw new Error('AI не ответил вовремя. Повторите запрос позже.');
            if (failure?.code === 'AI_NOT_CONFIGURED') throw new Error('AI пока не настроен на сервере.');
            throw new Error('Не удалось получить рекомендацию AI. Повторите позже.');
        }

        const data = await response.json();
        context.assertCurrent();
        if (data?.format !== 'markdown' || typeof data?.recommendation !== 'string') {
            throw new Error('Invalid AI response');
        }

        await this.repository.transaction([db.aiResultCache], () => db.aiResultCache.put({
            type,
            markdown: data.recommendation,
            updatedAt: new Date().toISOString(),
        }));
        context.assertCurrent();
        this.coordinator.broadcastUpdate();
        return data.recommendation;
    }
}
