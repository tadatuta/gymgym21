import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedApiFetch } from '../auth';
import { activateAccountDatabase, db } from '../db';
import { SYNC_PUSH_BYTES, SYNC_PUSH_LIMIT, SyncService } from './sync';

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

  it('times out stalled body reads and ignores late transport completion', async () => {
    let complete!: (value: unknown) => void;
    vi.mocked(authorizedApiFetch).mockResolvedValue({ ok: true, json: () => new Promise(resolve => { complete = resolve; }) } as Response);
    const pending = SyncService.sync();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    // The real deadline also covers body reads after headers arrive.
    const signal = vi.mocked(authorizedApiFetch).mock.calls.at(-1)![1]!.signal!;
    expect(signal.aborted).toBe(false);
    await rejected;
    expect(signal.aborted).toBe(true);
    complete({ protocolVersion: 1, cursor: 999, changes: {}, conflicts: [], acknowledged: [] });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await db.syncState.get('sync-cursor')).toBeUndefined();
  }, 35000);

  it('drains multiple batches of logs in bounded submitted snapshots, removes missing rows', async () => {
    const logs = Array.from({ length: 501 }, (_, i) => ({ id: `L${i}`, workoutTypeId: 'T', workoutId: 'W', date: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', reps: 1 }));
    await db.logs.bulkPut(logs);
    await SyncService.markDirtyMany([...logs.map(({ id }) => ({ entityType: 'logs' as const, entityId: id })), { entityType: 'logs', entityId: 'missing' }]);
    const seen = new Set<string>();
    vi.mocked(authorizedApiFetch).mockImplementation(async (_url, init) => {
      const body = String(init?.body);
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(SYNC_PUSH_BYTES);
      const sent = JSON.parse(body);
      expect(sent.changes.logs.length).toBeLessThanOrEqual(SYNC_PUSH_LIMIT);
      for (const log of sent.changes.logs) { expect(seen.has(log.id)).toBe(false); seen.add(log.id); }
      return jsonResponse({ protocolVersion: 1, cursor: seen.size, changes: sent.changes, conflicts: [], acknowledged: sent.changes.logs.map((log: { id: string }) => ({ entityType: 'logs', entityId: log.id })), hasMore: false });
    });
    let rounds = 0;
    while ((await SyncService.sync()).hasMore) { expect(++rounds).toBeLessThan(25); }
    expect(seen.size).toBe(501);
    expect(await db.dirtyEntities.count()).toBe(0);
    expect(authorizedApiFetch).toHaveBeenCalledTimes(2);
  }, 30000);

  it('uses UTF-8 byte bounds and stable retry IDs, skips oversized records without starving others', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `T${i}`, name: 'я'.repeat(9999), updatedAt: '2026-09-01T00:00:00Z', startTime: '2026-09-01T00:00:00Z', status: 'paused' as const, isManual: false, pauseIntervals: Array.from({ length: 1700 }, () => ({ start: '2026-09-01T00:00:00Z', end: '2026-09-01T00:00:00Z' })) }));
    await db.workouts.bulkPut([...rows, { ...rows[0], id: 'oversized', name: 'я'.repeat(SYNC_PUSH_BYTES) }]);
    await SyncService.markAllEntitiesDirty();
    vi.mocked(authorizedApiFetch).mockRejectedValueOnce(new Error('lost response')).mockImplementation(async (_url, init) => {
      expect(new TextEncoder().encode(String(init?.body)).length).toBeLessThanOrEqual(SYNC_PUSH_BYTES);
      const sent = JSON.parse(String(init?.body));
      return jsonResponse({ protocolVersion: 1, cursor: 0, changes: sent.changes, conflicts: [], acknowledged: (sent.changes.workouts ?? []).map(({ id }: { id: string }) => ({ entityType: 'workouts', entityId: id })), hasMore: false });
    });
    await expect(SyncService.sync()).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
    expect((await SyncService.sync()).hasMore).toBe(true);
    const calls = vi.mocked(authorizedApiFetch).mock.calls;
    expect(JSON.parse(String(calls[0][1]?.body)).batchId).toBe(JSON.parse(String(calls[1][1]?.body)).batchId);
    expect((await SyncService.sync()).hasMore).toBe(true);
    expect(await db.dirtyEntities.count()).toBe(1);
    await expect(SyncService.sync()).rejects.toThrow('oversized');
    expect(authorizedApiFetch).toHaveBeenCalledTimes(4);
  });

  it('retains invalid rows, drains valid rows, pulls remote data and requeues corrections', async () => {
    const now = '2026-09-01T00:00:00Z';
    await db.logs.put({ id: 'bad', workoutId: '', workoutTypeId: 'T', date: '2026-02-30', updatedAt: now });
    await db.workoutTypes.put({ id: 'good', name: 'Good', updatedAt: now });
    await SyncService.markAllEntitiesDirty();
    const generation = (await db.dirtyEntities.get('logs:bad'))!.generation;
    vi.mocked(authorizedApiFetch).mockImplementation(async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.protocolVersion).toBe(1);
      return jsonResponse({ protocolVersion: 1, cursor: 1, changes: { ...sent.changes, workoutTypes: [{ id: 'remote', name: 'Remote', updatedAt: now }] }, conflicts: [], acknowledged: [
        ...(sent.changes.workoutTypes ?? []).map((x: { id: string }) => ({ entityType: 'workoutTypes', entityId: x.id })),
        ...(sent.changes.logs ?? []).map((x: { id: string }) => ({ entityType: 'logs', entityId: x.id })),
      ] });
    });
    expect((await SyncService.sync()).hasMore).toBe(true);
    await expect(SyncService.sync()).rejects.toMatchObject({ code: 'INVALID_LOCAL_RECORD', retryable: false, details: { fields: ['date'] } });
    expect(await db.workoutTypes.get('remote')).toBeDefined();
    expect((await db.logs.get('bad'))!.date).toBe('2026-02-30');
    expect((await db.dirtyEntities.get('logs:bad'))!.generation).toBe(generation);
    await db.logs.update('bad', { date: now });
    await SyncService.markDirty('logs', 'bad');
    expect((await db.dirtyEntities.get('logs:bad'))!.generation).not.toBe(generation);
    expect((await SyncService.sync()).hasMore).toBe(false);
    expect(await db.dirtyEntities.count()).toBe(0);
  });

  it('keeps sent entries pending when the server explicitly acknowledges nothing', async () => {
    await db.workoutTypes.put({ id: 'A', name: 'Local', updatedAt: '2026-09-01T00:00:00Z' });
    await SyncService.markDirty('workoutTypes', 'A');
    const pending = await db.dirtyEntities.toArray();
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce(jsonResponse({
      protocolVersion: 1, cursor: 1, changes: {}, conflicts: [], acknowledged: [],
    }));
    expect((await SyncService.sync()).hasMore).toBe(true);
    expect(await db.dirtyEntities.toArray()).toEqual(pending);
    expect((await db.syncState.get('sync-cursor'))!.cursor).toBe(1);
  });

  it('validates every response before entity, cursor, conflict or acknowledgement writes', async () => {
    const now = '2026-09-01T00:00:00Z';
    await db.workoutTypes.put({ id: 'A', name: 'Local', updatedAt: now });
    await SyncService.markDirty('workoutTypes', 'A');
    await SyncService.markDirty('logs', 'missing');
    await db.logs.put({ id: 'L', workoutTypeId: 'A', workoutId: 'W', date: now, updatedAt: now });
    await db.workouts.put({ id: 'W', startTime: now, updatedAt: now, status: 'active', isManual: false, pauseIntervals: [] });
    await db.profile.put({ id: 'me', createdAt: now, updatedAt: now, isPublic: false });
    await db.syncState.put({ key: 'sync-cursor', cursor: 1, updatedAt: now });
    await db.syncConflicts.put({ key: 'workoutTypes:A', entityType: 'workoutTypes', entityId: 'A', reason: 'stale-version', serverVersion: 1, createdAt: now });
    const tables = [db.workoutTypes, db.logs, db.workouts, db.profile, db.syncState, db.syncConflicts, db.dirtyEntities];
    const before = await Promise.all(tables.map(table => table.toArray()));
    const good = { protocolVersion: 1, cursor: 2, changes: {}, conflicts: [], acknowledged: [{ entityType: 'workoutTypes', entityId: 'A' }] };
    for (const value of [null, {}, { ...good, protocolVersion: undefined }, { ...good, acknowledged: undefined }, { ...good, protocolVersion: 2 }, { ...good, cursor: 1.5 }, { ...good, hasMore: 'yes' },
      { ...good, changes: { workouts: [{ id: 'W', status: 'bogus' }] } }, { ...good, acknowledged: [{ entityType: 'alien', entityId: 'A' }] },
      { ...good, conflicts: [{ entityType: 'logs', entityId: '', reason: 'other', serverVersion: 2 }] },
      { ...good, changes: { workoutTypes: [{ id: 'A', name: 'one' }, { id: 'A', name: 'two' }] } }]) {
      vi.mocked(authorizedApiFetch).mockResolvedValueOnce(jsonResponse(value));
      await expect(SyncService.sync()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(await Promise.all(tables.map(table => table.toArray()))).toEqual(before);
    }
  });

  it.each([undefined, 2, 'missing-ack'])('rejects malformed backup response (%s) without applying imported changes', async (invalid) => {
    const original = { id: 'A', name: 'Local', updatedAt: '2026-09-01T00:00:00Z' };
    await db.workoutTypes.put(original);
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, cursor: 1, changes: {}, conflicts: [], acknowledged: [] }))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: invalid === 'missing-ack' ? 1 : invalid, acknowledged: invalid === 'missing-ack' ? undefined : [], cursor: 2, changes: { workoutTypes: [{ ...original, name: 'Corrupt' }] }, conflicts: [] }));
    await expect(new SyncService().importBackup({ workoutTypes: [original], workouts: [], logs: [] }, 'replace')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(await db.workoutTypes.get('A')).toEqual(original);
    expect((await db.syncState.get('sync-cursor'))!.cursor).toBe(1);
    expect(await db.dirtyEntities.count()).toBe(0);
  });

  it('imports after full fresh pull and preserves a newer local generation during replace', async () => {
    const original = { id: 'A', name: 'original', updatedAt: '2026-09-01T00:00:00Z', version: 2 };
    await db.workoutTypes.put(original);
    await db.syncState.put({ key: 'sync-cursor', cursor: 2, updatedAt: original.updatedAt });
    let finish: ((response: Response) => void) | undefined;
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, cursor: 2, changes: {}, conflicts: [], acknowledged: [], hasMore: true }))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, cursor: 3, changes: {}, conflicts: [], acknowledged: [], hasMore: false }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const importing = new SyncService().importBackup({ workoutTypes: [{ ...original, name: 'backup' }], workouts: [], logs: [] }, 'replace');
    await vi.waitFor(() => expect(authorizedApiFetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(vi.mocked(authorizedApiFetch).mock.calls[2][1]?.body))).toMatchObject({ mode: 'replace', expectedRevision: 3 });
    await db.workoutTypes.put({ ...original, name: 'new local edit' });
    await SyncService.markDirty('workoutTypes', 'A');
    const generation = (await db.dirtyEntities.get('workoutTypes:A'))!.generation;
    finish!(jsonResponse({ protocolVersion: 1, cursor: 5, changes: { workoutTypes: [{ ...original, name: 'backup', version: 4 }, { ...original, id: 'B', isDeleted: true, version: 5 }] }, conflicts: [], acknowledged: [] }));
    await importing;
    expect(await db.workoutTypes.get('A')).toMatchObject({ name: 'new local edit', version: 4 });
    expect((await db.dirtyEntities.get('workoutTypes:A'))!.generation).toBe(generation);
    expect(await db.workoutTypes.get('B')).toMatchObject({ isDeleted: true, version: 5 });
  });

  it('does not modify local data on revision conflict or offline replace', async () => {
    const original = { id: 'A', name: 'original', updatedAt: '2026-09-01T00:00:00Z', version: 2 };
    await db.workoutTypes.put(original);
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, cursor: 2, changes: {}, conflicts: [], acknowledged: [] }))
      .mockResolvedValueOnce(new Response('{}', { status: 409 }));
    const backup = { workoutTypes: [], workouts: [], logs: [] };
    await expect(new SyncService().importBackup(backup, 'replace')).rejects.toThrow('Данные изменились');
    expect(await db.workoutTypes.get('A')).toEqual(original);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await expect(new SyncService().importBackup(backup, 'replace')).rejects.toThrow('подключение');
    expect(await db.workoutTypes.get('A')).toEqual(original);
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

    await expect(SyncService.sync()).rejects.toMatchObject({ code: 'HTTP_503', retryable: true });
    await SyncService.sync();

    const firstRequest = JSON.parse(String(vi.mocked(authorizedApiFetch).mock.calls[0][1]?.body));
    const secondRequest = JSON.parse(String(vi.mocked(authorizedApiFetch).mock.calls[1][1]?.body));
    expect(firstRequest.batchId).toMatch(/^v1-[0-9a-f]{32}$/);
    expect(secondRequest.batchId).toBe(firstRequest.batchId);
  });
});

it('discards delayed sync from A after activating B, preserving both databases and A outbox', async () => {
  await activateAccountDatabase(`isolation-a-${Math.random()}`);
  const a = db;
  await a.workoutTypes.put({ id: 'a', name: 'A', updatedAt: '2026-09-01T00:00:00Z' });
  await SyncService.markDirty('workoutTypes', 'a');
  let finish!: (response: Response) => void;
  vi.mocked(authorizedApiFetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = SyncService.sync();
  const rejected = expect(pending).rejects.toThrow('Stale account operation');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await activateAccountDatabase(`isolation-b-${Math.random()}`);
  await db.workoutTypes.put({ id: 'b', name: 'B', updatedAt: '2026-09-01T00:00:00Z' });
  finish(jsonResponse({ protocolVersion: 1, cursor: 3, conflicts: [], acknowledged: [{ entityType: 'workoutTypes', entityId: 'a' }], changes: { workoutTypes: [{ id: 'a', name: 'SERVER A', version: 3 }] } }));
  await rejected;
  expect((await db.workoutTypes.toArray()).map(x => x.id)).toEqual(['b']);
  await a.open();
  expect((await a.workoutTypes.get('a'))?.name).toBe('A');
  expect(await a.dirtyEntities.count()).toBe(1);
  expect(await a.syncState.count()).toBe(0);
  a.close();
});
