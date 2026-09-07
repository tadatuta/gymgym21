import { parseSyncResponse, syncEntitySchemas } from './sync-validation';
import { SyncError, syncResponseError } from './sync-error';
import { authorizedApiFetch } from '../auth';
import { captureAccountContext } from '../db';
import {
  AppData,
  DirtyEntityRecord,
  SyncAcknowledgement,
  SyncConflictRecord,
  SyncDelta,
  SyncEntityType,
  SyncItem,
  SyncRequest,
  SyncResponse,
  SyncStateRecord,
  UserProfile,
  WorkoutSession,
  WorkoutSet,
  WorkoutType,
} from '../types';
import { createEntityId } from '../utils/entity-id';

const SYNC_CURSOR_KEY = 'sync-cursor';
const PROFILE_ID = 'me';
const SYNC_PROTOCOL_VERSION = 1;
const SYNC_PULL_LIMIT = 1000;
export const SYNC_PUSH_LIMIT = 500;
export const SYNC_PUSH_BYTES = 512 * 1024;

type SyncEntityMap = {
  workoutTypes: WorkoutType;
  logs: WorkoutSet;
  workouts: WorkoutSession;
  profile: UserProfile;
};

type ArrayEntityType = 'workoutTypes' | 'logs' | 'workouts';

interface SyncRequestSnapshot {
  missingEntries: Map<string, DirtyEntityRecord>;
  blocked?: SyncError;
  request: SyncRequest;
  dirtyEntries: Map<string, DirtyEntityRecord>;
}

export interface SyncExecutionResult {
  cursor: number;
  conflicts: number;
  pushedEntities: number;
  pulledEntities: number;
  hasMore: boolean;
}

export function dirtyKey(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function countDeltaEntities(delta: SyncDelta): number {
  return (delta.workoutTypes?.length ?? 0)
    + (delta.logs?.length ?? 0)
    + (delta.workouts?.length ?? 0)
    + (delta.profile ? 1 : 0);
}

function asArray<T>(items: T[] | undefined): T[] {
  return items ?? [];
}

function acknowledgementKeys(acknowledged: SyncAcknowledgement[]): Set<string> {
  return new Set(acknowledged.map((entry) => dirtyKey(entry.entityType, entry.entityId)));
}

function conflictKeys(response: SyncResponse): Set<string> {
  return new Set(response.conflicts.map((entry) => dirtyKey(entry.entityType, entry.entityId)));
}

function hashBatchPart(value: string, seed: bigint): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function createBatchId(cursor: number, dirtyEntries: Map<string, DirtyEntityRecord>): string {
  const source = [
    String(cursor),
    ...[...dirtyEntries.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => `${entry.key}:${entry.generation}`),
  ].join('|');
  return `v1-${hashBatchPart(source, 0xcbf29ce484222325n)}${hashBatchPart(source, 0x84222325cbf29ce4n)}`;
}

export class SyncService {
  private readonly db;
  constructor(private readonly context = captureAccountContext()) { this.db = context.database; }
  static sync(signal?: AbortSignal) { return new SyncService().sync(signal); }
  static markDirty(entityType: SyncEntityType, entityId: string) { return new SyncService().markDirty(entityType, entityId); }
  static markDirtyMany(changes: Array<{ entityType: SyncEntityType; entityId: string }>) { return new SyncService().markDirtyMany(changes); }
  static markAllEntitiesDirty() { return new SyncService().markAllEntitiesDirty(); }
  static bootstrapDirtyState() { return new SyncService().bootstrapDirtyState(); }
  static readAll() { return new SyncService().readAll(); }

  async sync(signal?: AbortSignal): Promise<SyncExecutionResult> {
    if (!navigator.onLine) {
      throw new SyncError('Нет подключения к сети', 'OFFLINE');
    }

    const snapshot = await this.createRequestSnapshot();
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, this.context.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => controller.abort(new SyncError('Сервер не ответил за 30 секунд. Повторим автоматически.', 'TIMEOUT', true)), 30_000);
    let result: SyncResponse;
    let onAbort: (() => void) | undefined;
    try {
      // Racing also releases the scheduler when a transport ignores cancellation.
      const aborted = new Promise<never>((_, reject) => {
        if (combined.aborted) reject(combined.reason);
        else {
          onAbort = () => reject(combined.reason);
          combined.addEventListener('abort', onAbort, { once: true });
        }
      });
      const request = async () => {
        const response = await authorizedApiFetch('/me/storage/sync', {
          signal: combined,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot.request),
        }, this.context);

        this.context.assertCurrent();
        if (combined.aborted) throw combined.reason;
        if (!response.ok) throw await syncResponseError(response);
        return parseSyncResponse(await response.json());
      };
      result = await Promise.race([request(), aborted]);
    } catch (error) {
      this.context.assertCurrent();
      if (error instanceof SyncError || combined.aborted) throw combined.aborted ? combined.reason : error;
      if (error instanceof SyntaxError) throw new SyncError('Некорректный ответ сервера. Повторите позже или обратитесь в поддержку.', 'INVALID_RESPONSE');
      throw new SyncError('Не удалось связаться с сервером. Повторим автоматически.', 'NETWORK', true);
    } finally {
      clearTimeout(timer);
      if (onAbort) combined.removeEventListener('abort', onAbort);
    }
    if (combined.aborted) throw combined.reason;
    const pulledEntities = countDeltaEntities(result.changes);
    const pushedEntities = countDeltaEntities(snapshot.request.changes);

    this.context.assertCurrent();
    await this.applySyncResponse(result, snapshot);
    this.context.assertCurrent();

    if (snapshot.blocked && !pushedEntities && !result.hasMore) throw snapshot.blocked;

    return {
      cursor: result.cursor,
      conflicts: result.conflicts.length,
      pushedEntities,
      pulledEntities,
      hasMore: Boolean(result.hasMore) || await this.db.dirtyEntities.count() > 0,
    };
  }

  async importBackup(data: AppData, mode: 'merge' | 'replace'): Promise<void> {
    if (!navigator.onLine) throw new Error('Для замены данных необходимо подключение к серверу');
    // Finish the entire pull before choosing the revision the user is replacing.
    let result: SyncExecutionResult;
    do {
      result = await this.sync();
      if (result.conflicts) throw new Error('Сначала разрешите конфликты синхронизации');
    } while (result.hasMore);
    const snapshot = await this.createRequestSnapshot();
    if (snapshot.dirtyEntries.size || await this.db.syncConflicts.count()) throw new Error('Есть несинхронизированные изменения или конфликты. Повторите импорт после синхронизации');
    this.context.assertCurrent();
    const response = await authorizedApiFetch('/me/storage/backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, expectedRevision: snapshot.request.cursor, data }),
    }, this.context);
    this.context.assertCurrent();
    if (response.status === 409) throw new Error('Данные изменились на другом устройстве. Синхронизируйте и повторите импорт');
    if (response.status === 413) throw new Error('Файл превышает лимит импорта сервера. Уменьшите файл или согласуйте JSON_BODY_LIMIT и лимит прокси');
    if (!response.ok) throw new Error('Не удалось подтвердить импорт на сервере. Синхронизируйте данные перед повторной попыткой');
    const imported = parseSyncResponse(await response.json());
    this.context.assertCurrent();
    await this.applySyncResponse(imported, snapshot);
    this.context.assertCurrent();
  }

  async markDirty(entityType: SyncEntityType, entityId: string) {
    await this.markDirtyMany([{ entityType, entityId }]);
  }

  async markDirtyMany(changes: Array<{ entityType: SyncEntityType; entityId: string }>) {
    this.context.assertCurrent();
    const uniqueChanges = new Map(
      changes.map((change) => [dirtyKey(change.entityType, change.entityId), change]),
    );
    if (uniqueChanges.size === 0) {
      return;
    }

    const queuedAt = new Date().toISOString();
    await this.db.dirtyEntities.bulkPut(
      [...uniqueChanges.entries()].map(([key, { entityType, entityId }]) => ({
        key,
        entityType,
        entityId,
        queuedAt,
        generation: createEntityId(),
      })),
    );
  }

  async markAllEntitiesDirty() {
    await this.markDirtyMany(await this.listAllEntityKeys());
  }

  async bootstrapDirtyState() {
    this.context.assertCurrent();
    await this.db.transaction(
      'rw',
      [this.db.workouts, this.db.logs, this.db.workoutTypes, this.db.profile, this.db.dirtyEntities, this.db.syncState],
      async () => {
        this.context.assertCurrent();
        const dirtyEntries = await this.db.dirtyEntities.toArray();
        this.context.assertCurrent();
        const entriesWithoutGeneration = dirtyEntries.filter((entry) => !entry.generation);
        if (entriesWithoutGeneration.length > 0) {
          await this.db.dirtyEntities.bulkPut(
            entriesWithoutGeneration.map((entry) => ({
              ...entry,
              generation: createEntityId(),
            })),
          );
        }

        const cursor = await this.getCursor();
        this.context.assertCurrent();
        if (cursor > 0 || dirtyEntries.length > 0) {
          return;
        }

        const unsyncedEntities = await this.listUnsyncedEntities();
        if (unsyncedEntities.length > 0) {
          await this.markDirtyMany(unsyncedEntities);
        }
        this.context.assertCurrent();
      },
    );
  }

  async readAll(): Promise<AppData> {
    const [workouts, logs, workoutTypes, profile] = await Promise.all([
      this.db.workouts.toArray(),
      this.db.logs.toArray(),
      this.db.workoutTypes.toArray(),
      this.db.profile.get(PROFILE_ID),
    ]);

    return {
      workouts,
      logs,
      workoutTypes,
      profile,
    };
  }

  private async createRequestSnapshot(): Promise<SyncRequestSnapshot> {
    return this.db.transaction(
      'rw',
      [this.db.workouts, this.db.logs, this.db.workoutTypes, this.db.profile, this.db.dirtyEntities, this.db.syncState],
      async () => {
        const cursor = await this.getCursor();
        const dirtyEntryList = await this.db.dirtyEntities.toArray();
        const entities = this.buildEntityMap(await this.readDirtyDelta(dirtyEntryList));
        const dirtyEntries = new Map<string, DirtyEntityRecord>();
        const missingEntries = new Map<string, DirtyEntityRecord>();
        const changes: SyncDelta = {};
        // Reserve the envelope, property names and punctuation; entity bytes are UTF-8.
        let bytes = 1024;
        let oversized: string | undefined;
        let blocked: SyncError | undefined;
        for (const entry of dirtyEntryList) {
          if (dirtyEntries.size >= SYNC_PUSH_LIMIT) break;
          let entity = entities.get(entry.key);
          if (!entity && entry.entityType === 'profile') entity = await this.db.profile.get(entry.entityId);
          if (!entity) {
            // Defer cleanup until a valid response, preserving outbox on malformed responses.
            missingEntries.set(entry.key, entry);
            continue;
          }
          const size = new TextEncoder().encode(JSON.stringify(entity)).byteLength + 1;
          if (size + 1024 > SYNC_PUSH_BYTES) {
            oversized ??= entry.key;
            continue;
          }
          const validation = syncEntitySchemas[entry.entityType].safeParse(entity);
          if (!validation.success) {
            const fields = validation.error.issues.map((issue) => issue.path.join('.')).filter(Boolean).slice(0, 5);
            blocked ??= new SyncError(`Запись ${entry.key.slice(0, 160)} содержит некорректные поля: ${fields.join(', ')}. Исправьте запись и повторите синхронизацию; исходные данные сохранены на устройстве.`, 'INVALID_LOCAL_RECORD', false, 0, { recordId: entry.key, fields });
            continue;
          }
          entity = validation.data as SyncItem;
          if (bytes + size > SYNC_PUSH_BYTES) continue;
          bytes += size;
          dirtyEntries.set(entry.key, entry);
          if (entry.entityType === 'profile') changes.profile = entity as UserProfile;
          else if (entry.entityType === 'logs') (changes.logs ??= []).push(entity as WorkoutSet);
          else if (entry.entityType === 'workouts') (changes.workouts ??= []).push(entity as WorkoutSession);
          else (changes.workoutTypes ??= []).push(entity as WorkoutType);
        }
        if (oversized) {
          blocked ??= new SyncError(`Запись ${oversized} превышает лимит синхронизации 512 КиБ. Сократите содержимое записи и повторите синхронизацию`, 'RECORD_TOO_LARGE', false, 0, { recordId: oversized });
        }
        return {
          blocked, missingEntries,
          request: { cursor, changes, protocolVersion: SYNC_PROTOCOL_VERSION,
            limit: SYNC_PULL_LIMIT, batchId: createBatchId(cursor, dirtyEntries) },
          dirtyEntries,
        };
      },
    );
  }

  private async readDirtyDelta(dirtyEntries: DirtyEntityRecord[]): Promise<SyncDelta> {
    const grouped = new Map<SyncEntityType, string[]>();
    for (const entry of dirtyEntries) {
      const list = grouped.get(entry.entityType) ?? [];
      list.push(entry.entityId);
      grouped.set(entry.entityType, list);
    }

    const workoutTypes = await this.bulkGet('workoutTypes', grouped.get('workoutTypes'));
    const logs = await this.bulkGet('logs', grouped.get('logs'));
    const workouts = await this.bulkGet('workouts', grouped.get('workouts'));
    const profileIds = grouped.get('profile');
    const profile = profileIds?.includes(PROFILE_ID) ? await this.db.profile.get(PROFILE_ID) : undefined;

    return {
      ...(workoutTypes.length > 0 ? { workoutTypes } : {}),
      ...(logs.length > 0 ? { logs } : {}),
      ...(workouts.length > 0 ? { workouts } : {}),
      ...(profile ? { profile } : {}),
    };
  }

  private async bulkGet<K extends ArrayEntityType>(
    entityType: K,
    ids: string[] | undefined,
  ): Promise<SyncEntityMap[K][]> {
    if (!ids?.length) {
      return [];
    }

    const items = await this.getArrayTable(entityType).bulkGet(ids);
    return items.filter((item): item is SyncEntityMap[K] => Boolean(item));
  }

  private getArrayTable<K extends ArrayEntityType>(entityType: K) {
    switch (entityType) {
      case 'workoutTypes':
        return this.db.workoutTypes;
      case 'logs':
        return this.db.logs;
      case 'workouts':
        return this.db.workouts;
    }
  }

  private async applySyncResponse(response: SyncResponse, snapshot: SyncRequestSnapshot) {
    const acknowledged = acknowledgementKeys(response.acknowledged);
    const conflicts = conflictKeys(response);

    await this.db.transaction(
      'rw',
      [this.db.workouts, this.db.logs, this.db.workoutTypes, this.db.profile, this.db.dirtyEntities, this.db.syncState, this.db.syncConflicts],
      async () => {
        await this.applyArrayDelta('workoutTypes', response.changes.workoutTypes, snapshot);
        await this.applyArrayDelta('logs', response.changes.logs, snapshot);
        await this.applyArrayDelta('workouts', response.changes.workouts, snapshot);

        if (response.changes.profile) {
          await this.applyProfileDelta(response.changes.profile, snapshot, acknowledged, conflicts);
        }

        await this.recordConflicts(response, snapshot.request);
        await this.acknowledgeUnchangedOutboxEntries(snapshot, acknowledged, conflicts);
        const missingKeys = [...snapshot.missingEntries.keys()];
        const currentMissing = await this.db.dirtyEntities.bulkGet(missingKeys);
        await this.db.dirtyEntities.bulkDelete(missingKeys.filter((key, index) =>
          currentMissing[index]?.generation === snapshot.missingEntries.get(key)!.generation));

        const syncState: SyncStateRecord = {
          key: SYNC_CURSOR_KEY,
          cursor: response.cursor,
          updatedAt: new Date().toISOString(),
        };
        await this.db.syncState.put(syncState);
        // Throwing inside the transaction rolls back all writes if the account changed.
        this.context.assertCurrent();
      },
    );
  }

  private async applyArrayDelta<K extends ArrayEntityType>(
    entityType: K,
    incomingItems: SyncEntityMap[K][] | undefined,
    snapshot: SyncRequestSnapshot,
  ) {
    const incoming = asArray(incomingItems);
    if (!incoming.length) return;
    const table = this.getArrayTable(entityType);
    const keys = incoming.map((item) => dirtyKey(entityType, item.id));
    const locals = await table.bulkGet(incoming.map((item) => item.id));
    const dirty = await this.db.dirtyEntities.bulkGet(keys);
    const writes: SyncEntityMap[K][] = [];
    incoming.forEach((item, index) => {
      const local = locals[index] as SyncEntityMap[K] | undefined;
      const sent = snapshot.dirtyEntries.get(keys[index]);
      const current = dirty[index];
      if (current && (!sent || current.generation !== sent.generation) && local) {
        writes.push({ ...local, version: item.version, serverUpdatedAt: item.serverUpdatedAt });
      } else if (!local || this.shouldReplaceLocal(local, item)) {
        writes.push(item);
      }
    });
    // All writes and generation-aware acknowledgements share applySyncResponse's tx.
    switch (entityType) {
      case 'logs': await this.db.logs.bulkPut(writes as WorkoutSet[]); break;
      case 'workouts': await this.db.workouts.bulkPut(writes as WorkoutSession[]); break;
      case 'workoutTypes': await this.db.workoutTypes.bulkPut(writes as WorkoutType[]); break;
    }
  }

  private async applyProfileDelta(
    incoming: UserProfile,
    snapshot: SyncRequestSnapshot,
    acknowledged: Set<string>,
    conflicts: Set<string>,
  ) {
    const key = dirtyKey('profile', PROFILE_ID);
    const local = await this.db.profile.get(PROFILE_ID);
    const dirtyState = await this.getDirtyState(key, snapshot);

    if (dirtyState.changedAfterSnapshot && local) {
      await this.db.profile.put({
        ...local,
        id: PROFILE_ID,
        version: incoming.version,
        serverUpdatedAt: incoming.serverUpdatedAt,
      });
    } else if (!local || this.shouldReplaceLocal(local, incoming)) {
      await this.db.profile.put({ ...incoming, id: PROFILE_ID });
    }

    if (acknowledged.has(key) && dirtyState.matchesSnapshot) {
      await this.db.dirtyEntities.delete(key);
      if (!conflicts.has(key)) {
        await this.db.syncConflicts.delete(key);
      }
    }
  }

  private async getDirtyState(key: string, snapshot: SyncRequestSnapshot) {
    const current = await this.db.dirtyEntities.get(key);
    const sent = snapshot.dirtyEntries.get(key);
    return {
      matchesSnapshot: Boolean(current && sent && current.generation === sent.generation),
      changedAfterSnapshot: Boolean(current && (!sent || current.generation !== sent.generation)),
    };
  }

  private async acknowledgeUnchangedOutboxEntries(
    snapshot: SyncRequestSnapshot,
    acknowledged: Set<string>,
    conflicts: Set<string>,
  ) {
    const keys = [...acknowledged].filter((key) => snapshot.dirtyEntries.has(key));
    const current = await this.db.dirtyEntities.bulkGet(keys);
    const matching = keys.filter((key, index) => current[index]
      && snapshot.dirtyEntries.get(key)!.generation === current[index]!.generation);
    await this.db.dirtyEntities.bulkDelete(matching);
    await this.db.syncConflicts.bulkDelete(matching.filter((key) => !conflicts.has(key)));
  }

  private shouldReplaceLocal<T extends SyncItem>(local: T, incoming: T): boolean {
    const localVersion = local.version ?? 0;
    const incomingVersion = incoming.version ?? 0;

    if (incomingVersion !== localVersion) {
      return incomingVersion > localVersion;
    }

    const localServerUpdatedAt = local.serverUpdatedAt ? new Date(local.serverUpdatedAt).getTime() : 0;
    const incomingServerUpdatedAt = incoming.serverUpdatedAt ? new Date(incoming.serverUpdatedAt).getTime() : 0;

    if (incomingServerUpdatedAt !== localServerUpdatedAt) {
      return incomingServerUpdatedAt >= localServerUpdatedAt;
    }

    return new Date(incoming.updatedAt).getTime() >= new Date(local.updatedAt).getTime();
  }

  private async recordConflicts(response: SyncResponse, request: SyncRequest) {
    const now = new Date().toISOString();
    const localMap = this.buildEntityMap(request.changes);
    const serverMap = this.buildEntityMap(response.changes);

    for (const conflict of response.conflicts) {
      const key = dirtyKey(conflict.entityType, conflict.entityId);
      const record: SyncConflictRecord = {
        key,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        reason: conflict.reason,
        serverVersion: conflict.serverVersion,
        localPayload: localMap.get(key),
        serverPayload: serverMap.get(key),
        createdAt: now,
      };
      await this.db.syncConflicts.put(record);
    }
  }

  private buildEntityMap(delta: SyncDelta): Map<string, SyncItem> {
    const entries = new Map<string, SyncItem>();

    for (const item of delta.workoutTypes ?? []) {
      entries.set(dirtyKey('workoutTypes', item.id), item);
    }
    for (const item of delta.logs ?? []) {
      entries.set(dirtyKey('logs', item.id), item);
    }
    for (const item of delta.workouts ?? []) {
      entries.set(dirtyKey('workouts', item.id), item);
    }
    if (delta.profile) {
      entries.set(dirtyKey('profile', delta.profile.id), delta.profile);
    }

    return entries;
  }

  private async getCursor(): Promise<number> {
    return (await this.db.syncState.get(SYNC_CURSOR_KEY))?.cursor ?? 0;
  }

  private async listUnsyncedEntities(): Promise<Array<{ entityType: SyncEntityType; entityId: string }>> {
    const [workoutTypes, logs, workouts, profile] = await Promise.all([
      this.db.workoutTypes.toArray(),
      this.db.logs.toArray(),
      this.db.workouts.toArray(),
      this.db.profile.toArray(),
    ]);

    return [
      ...workoutTypes.filter((item) => !item.version).map((item) => ({ entityType: 'workoutTypes' as const, entityId: item.id })),
      ...logs.filter((item) => !item.version).map((item) => ({ entityType: 'logs' as const, entityId: item.id })),
      ...workouts.filter((item) => !item.version).map((item) => ({ entityType: 'workouts' as const, entityId: item.id })),
      ...profile.filter((item) => !item.version).map((item) => ({ entityType: 'profile' as const, entityId: item.id })),
    ];
  }

  private async listAllEntityKeys(): Promise<Array<{ entityType: SyncEntityType; entityId: string }>> {
    const [workoutTypes, logs, workouts, profile] = await Promise.all([
      this.db.workoutTypes.toArray(),
      this.db.logs.toArray(),
      this.db.workouts.toArray(),
      this.db.profile.toArray(),
    ]);

    return [
      ...workoutTypes.map((item) => ({ entityType: 'workoutTypes' as const, entityId: item.id })),
      ...logs.map((item) => ({ entityType: 'logs' as const, entityId: item.id })),
      ...workouts.map((item) => ({ entityType: 'workouts' as const, entityId: item.id })),
      ...profile.map((item) => ({ entityType: 'profile' as const, entityId: item.id })),
    ];
  }
}
