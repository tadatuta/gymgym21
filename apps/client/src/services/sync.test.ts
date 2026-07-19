import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedApiFetch } from '../auth';
import { activateAccountDatabase, db } from '../db';
import { SyncService } from './sync';

vi.mock('../auth', () => ({
  authorizedApiFetch: vi.fn(),
}));

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SyncService reliable outbox acknowledgements', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    await activateAccountDatabase(`sync-test-${Math.random().toString(36).slice(2)}`);
  });

  it('preserves and rebases an edit made while a sync request is in flight', async () => {
    const id = 'exercise-1';
    await db.workoutTypes.put({
      id,
      name: 'Отправленная версия',
      updatedAt: '2026-07-19T10:00:00.000Z',
      version: 1,
      serverUpdatedAt: '2026-07-19T09:00:00.000Z',
    });
    await SyncService.markDirty('workoutTypes', id);

    let finishRequest: ((response: Response) => void) | undefined;
    vi.mocked(authorizedApiFetch).mockImplementation(() => new Promise((resolve) => {
      finishRequest = resolve;
    }));

    const syncPromise = SyncService.sync();
    await vi.waitFor(() => expect(authorizedApiFetch).toHaveBeenCalledOnce());
    const sentRequest = JSON.parse(String(vi.mocked(authorizedApiFetch).mock.calls[0][1]?.body));

    await db.workoutTypes.put({
      ...(await db.workoutTypes.get(id))!,
      name: 'Изменено во время запроса',
      updatedAt: '2026-07-19T10:01:00.000Z',
    });
    await SyncService.markDirty('workoutTypes', id);
    const newerOutboxGeneration = (await db.dirtyEntities.get(`workoutTypes:${id}`))!.generation;

    finishRequest?.(jsonResponse({
      cursor: 2,
      protocolVersion: 1,
      acknowledged: [{ entityType: 'workoutTypes', entityId: id }],
      conflicts: [],
      changes: {
        workoutTypes: [{
          ...sentRequest.changes.workoutTypes[0],
          version: 2,
          serverUpdatedAt: '2026-07-19T10:00:30.000Z',
        }],
        logs: [],
        workouts: [],
        profile: null,
      },
    }));
    await syncPromise;

    const local = await db.workoutTypes.get(id);
    const outbox = await db.dirtyEntities.get(`workoutTypes:${id}`);
    expect(local?.name).toBe('Изменено во время запроса');
    expect(local?.version).toBe(2);
    expect(outbox?.generation).toBe(newerOutboxGeneration);
  });

  it('keeps a stale local payload in conflict storage while applying the server version', async () => {
    const id = 'exercise-conflict';
    await db.workoutTypes.put({
      id,
      name: 'Локальный вариант',
      updatedAt: '2026-07-19T10:00:00.000Z',
      version: 1,
    });
    await SyncService.markDirty('workoutTypes', id);

    vi.mocked(authorizedApiFetch).mockResolvedValue(jsonResponse({
      cursor: 2,
      protocolVersion: 1,
      acknowledged: [{ entityType: 'workoutTypes', entityId: id }],
      conflicts: [{
        entityType: 'workoutTypes',
        entityId: id,
        reason: 'stale-version',
        serverVersion: 2,
      }],
      changes: {
        workoutTypes: [{
          id,
          name: 'Серверный вариант',
          updatedAt: '2026-07-19T10:02:00.000Z',
          version: 2,
          serverUpdatedAt: '2026-07-19T10:02:00.000Z',
        }],
        logs: [],
        workouts: [],
        profile: null,
      },
    }));

    await SyncService.sync();

    expect((await db.workoutTypes.get(id))?.name).toBe('Серверный вариант');
    expect(await db.dirtyEntities.get(`workoutTypes:${id}`)).toBeUndefined();
    const conflict = await db.syncConflicts.get(`workoutTypes:${id}`);
    expect((conflict?.localPayload as { name?: string })?.name).toBe('Локальный вариант');
    expect((conflict?.serverPayload as { name?: string })?.name).toBe('Серверный вариант');
  });

  it('acknowledges deletion of an entity that never existed on the server', async () => {
    const id = 'never-synced';
    await db.workoutTypes.put({
      id,
      name: 'Удалено до первого sync',
      updatedAt: '2026-07-19T10:00:00.000Z',
      isDeleted: true,
    });
    await SyncService.markDirty('workoutTypes', id);
    vi.mocked(authorizedApiFetch).mockResolvedValue(jsonResponse({
      cursor: 0,
      protocolVersion: 1,
      acknowledged: [{ entityType: 'workoutTypes', entityId: id }],
      conflicts: [],
      changes: {
        workoutTypes: [],
        logs: [],
        workouts: [],
        profile: null,
      },
    }));

    await SyncService.sync();

    expect(await db.dirtyEntities.get(`workoutTypes:${id}`)).toBeUndefined();
    expect((await db.workoutTypes.get(id))?.isDeleted).toBe(true);
  });

  it('reuses a stable batch id when an unchanged outbox is retried', async () => {
    const id = 'retry-me';
    await db.workoutTypes.put({
      id,
      name: 'Retry',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    await SyncService.markDirty('workoutTypes', id);
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({
        cursor: 1,
        protocolVersion: 1,
        hasMore: false,
        acknowledged: [{ entityType: 'workoutTypes', entityId: id }],
        conflicts: [],
        changes: {
          workoutTypes: [{
            id,
            name: 'Retry',
            updatedAt: '2026-07-19T10:00:00.000Z',
            version: 1,
            serverUpdatedAt: '2026-07-19T10:00:01.000Z',
          }],
          logs: [],
          workouts: [],
          profile: null,
        },
      }));

    await expect(SyncService.sync()).rejects.toThrow('Sync failed');
    await SyncService.sync();

    const firstRequest = JSON.parse(String(vi.mocked(authorizedApiFetch).mock.calls[0][1]?.body));
    const secondRequest = JSON.parse(String(vi.mocked(authorizedApiFetch).mock.calls[1][1]?.body));
    expect(firstRequest.batchId).toMatch(/^v1-[0-9a-f]{32}$/);
    expect(secondRequest.batchId).toBe(firstRequest.batchId);
  });
});
