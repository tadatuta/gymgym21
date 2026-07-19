import { authorizedApiFetch } from '../auth';
import { db } from '../db';
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

type SyncEntityMap = {
  workoutTypes: WorkoutType;
  logs: WorkoutSet;
  workouts: WorkoutSession;
  profile: UserProfile;
};

type ArrayEntityType = 'workoutTypes' | 'logs' | 'workouts';

interface SyncRequestSnapshot {
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
  static async sync(): Promise<SyncExecutionResult> {
    if (!navigator.onLine) {
      throw new Error('Offline');
    }

    const snapshot = await this.createRequestSnapshot();
    const response = await authorizedApiFetch('/me/storage/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(snapshot.request),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Unauthorized');
      }
      throw new Error('Sync failed');
    }

    const result = await response.json() as SyncResponse;
    const pulledEntities = countDeltaEntities(result.changes);
    const pushedEntities = countDeltaEntities(snapshot.request.changes);

    await this.applySyncResponse(result, snapshot);

    return {
      cursor: result.cursor,
      conflicts: result.conflicts.length,
      pushedEntities,
      pulledEntities,
      hasMore: result.hasMore ?? false,
    };
  }

  static async markDirty(entityType: SyncEntityType, entityId: string) {
    await this.markDirtyMany([{ entityType, entityId }]);
  }

  static async markDirtyMany(changes: Array<{ entityType: SyncEntityType; entityId: string }>) {
    const uniqueChanges = new Map(
      changes.map((change) => [dirtyKey(change.entityType, change.entityId), change]),
    );
    if (uniqueChanges.size === 0) {
      return;
    }

    const queuedAt = new Date().toISOString();
    await db.dirtyEntities.bulkPut(
      [...uniqueChanges.entries()].map(([key, { entityType, entityId }]) => ({
        key,
        entityType,
        entityId,
        queuedAt,
        generation: createEntityId(),
      })),
    );
  }

  static async markAllEntitiesDirty() {
    await this.markDirtyMany(await this.listAllEntityKeys());
  }

  static async bootstrapDirtyState() {
    await db.transaction(
      'rw',
      [db.workouts, db.logs, db.workoutTypes, db.profile, db.dirtyEntities, db.syncState],
      async () => {
        const dirtyEntries = await db.dirtyEntities.toArray();
        const entriesWithoutGeneration = dirtyEntries.filter((entry) => !entry.generation);
        if (entriesWithoutGeneration.length > 0) {
          await db.dirtyEntities.bulkPut(
            entriesWithoutGeneration.map((entry) => ({
              ...entry,
              generation: createEntityId(),
            })),
          );
        }

        const cursor = await this.getCursor();
        if (cursor > 0 || dirtyEntries.length > 0) {
          return;
        }

        const unsyncedEntities = await this.listUnsyncedEntities();
        if (unsyncedEntities.length > 0) {
          await this.markDirtyMany(unsyncedEntities);
        }
      },
    );
  }

  static async readAll(): Promise<AppData> {
    const [workouts, logs, workoutTypes, profile] = await Promise.all([
      db.workouts.toArray(),
      db.logs.toArray(),
      db.workoutTypes.toArray(),
      db.profile.get(PROFILE_ID),
    ]);

    return {
      workouts,
      logs,
      workoutTypes,
      profile,
    };
  }

  private static async createRequestSnapshot(): Promise<SyncRequestSnapshot> {
    return db.transaction(
      'r',
      [db.workouts, db.logs, db.workoutTypes, db.profile, db.dirtyEntities, db.syncState],
      async () => {
        const [cursor, dirtyEntryList] = await Promise.all([
          this.getCursor(),
          db.dirtyEntities.toArray(),
        ]);
        const dirtyEntries = new Map(dirtyEntryList.map((entry) => [entry.key, entry]));

        return {
          request: {
            cursor,
            changes: await this.readDirtyDelta(dirtyEntryList),
            protocolVersion: SYNC_PROTOCOL_VERSION,
            limit: SYNC_PULL_LIMIT,
            batchId: createBatchId(cursor, dirtyEntries),
          },
          dirtyEntries,
        };
      },
    );
  }

  private static async readDirtyDelta(dirtyEntries: DirtyEntityRecord[]): Promise<SyncDelta> {
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
    const profile = profileIds?.includes(PROFILE_ID) ? await db.profile.get(PROFILE_ID) : undefined;

    return {
      ...(workoutTypes.length > 0 ? { workoutTypes } : {}),
      ...(logs.length > 0 ? { logs } : {}),
      ...(workouts.length > 0 ? { workouts } : {}),
      ...(profile ? { profile } : {}),
    };
  }

  private static async bulkGet<K extends ArrayEntityType>(
    entityType: K,
    ids: string[] | undefined,
  ): Promise<SyncEntityMap[K][]> {
    if (!ids?.length) {
      return [];
    }

    const items = await this.getArrayTable(entityType).bulkGet(ids);
    return items.filter((item): item is SyncEntityMap[K] => Boolean(item));
  }

  private static getArrayTable<K extends ArrayEntityType>(entityType: K) {
    switch (entityType) {
      case 'workoutTypes':
        return db.workoutTypes;
      case 'logs':
        return db.logs;
      case 'workouts':
        return db.workouts;
    }
  }

  private static async applySyncResponse(response: SyncResponse, snapshot: SyncRequestSnapshot) {
    const fallbackAcknowledgements = [
      ...snapshot.dirtyEntries.values(),
    ].map(({ entityType, entityId }) => ({ entityType, entityId }));
    const acknowledged = acknowledgementKeys(response.acknowledged ?? fallbackAcknowledgements);
    const conflicts = conflictKeys(response);

    await db.transaction(
      'rw',
      [db.workouts, db.logs, db.workoutTypes, db.profile, db.dirtyEntities, db.syncState, db.syncConflicts],
      async () => {
        await this.applyArrayDelta('workoutTypes', response.changes.workoutTypes, snapshot, acknowledged, conflicts);
        await this.applyArrayDelta('logs', response.changes.logs, snapshot, acknowledged, conflicts);
        await this.applyArrayDelta('workouts', response.changes.workouts, snapshot, acknowledged, conflicts);

        if (response.changes.profile) {
          await this.applyProfileDelta(response.changes.profile, snapshot, acknowledged, conflicts);
        }

        await this.recordConflicts(response, snapshot.request);
        await this.acknowledgeUnchangedOutboxEntries(snapshot, acknowledged, conflicts);

        const syncState: SyncStateRecord = {
          key: SYNC_CURSOR_KEY,
          cursor: response.cursor,
          updatedAt: new Date().toISOString(),
        };
        await db.syncState.put(syncState);
      },
    );
  }

  private static async applyArrayDelta<K extends ArrayEntityType>(
    entityType: K,
    incomingItems: SyncEntityMap[K][] | undefined,
    snapshot: SyncRequestSnapshot,
    acknowledged: Set<string>,
    conflicts: Set<string>,
  ) {
    for (const incoming of asArray(incomingItems)) {
      const key = dirtyKey(entityType, incoming.id);
      const table = this.getArrayTable(entityType);
      const local = await table.get(incoming.id) as SyncEntityMap[K] | undefined;
      const dirtyState = await this.getDirtyState(key, snapshot);

      if (dirtyState.changedAfterSnapshot && local) {
        await this.putRebasedArrayEntity(entityType, local, incoming);
      } else if (!local || this.shouldReplaceLocal(local, incoming)) {
        await this.putArrayEntity(entityType, incoming);
      }

      if (acknowledged.has(key) && dirtyState.matchesSnapshot) {
        await db.dirtyEntities.delete(key);
        if (!conflicts.has(key)) {
          await db.syncConflicts.delete(key);
        }
      }
    }
  }

  private static async applyProfileDelta(
    incoming: UserProfile,
    snapshot: SyncRequestSnapshot,
    acknowledged: Set<string>,
    conflicts: Set<string>,
  ) {
    const key = dirtyKey('profile', PROFILE_ID);
    const local = await db.profile.get(PROFILE_ID);
    const dirtyState = await this.getDirtyState(key, snapshot);

    if (dirtyState.changedAfterSnapshot && local) {
      await db.profile.put({
        ...local,
        id: PROFILE_ID,
        version: incoming.version,
        serverUpdatedAt: incoming.serverUpdatedAt,
      });
    } else if (!local || this.shouldReplaceLocal(local, incoming)) {
      await db.profile.put({ ...incoming, id: PROFILE_ID });
    }

    if (acknowledged.has(key) && dirtyState.matchesSnapshot) {
      await db.dirtyEntities.delete(key);
      if (!conflicts.has(key)) {
        await db.syncConflicts.delete(key);
      }
    }
  }

  private static async getDirtyState(key: string, snapshot: SyncRequestSnapshot) {
    const current = await db.dirtyEntities.get(key);
    const sent = snapshot.dirtyEntries.get(key);
    return {
      matchesSnapshot: Boolean(current && sent && current.generation === sent.generation),
      changedAfterSnapshot: Boolean(current && (!sent || current.generation !== sent.generation)),
    };
  }

  private static async putArrayEntity<K extends ArrayEntityType>(entityType: K, entity: SyncEntityMap[K]) {
    switch (entityType) {
      case 'workoutTypes':
        await db.workoutTypes.put(entity as WorkoutType);
        break;
      case 'logs':
        await db.logs.put(entity as WorkoutSet);
        break;
      case 'workouts':
        await db.workouts.put(entity as WorkoutSession);
        break;
    }
  }

  private static async putRebasedArrayEntity<K extends ArrayEntityType>(
    entityType: K,
    local: SyncEntityMap[K],
    incoming: SyncEntityMap[K],
  ) {
    await this.putArrayEntity(entityType, {
      ...local,
      version: incoming.version,
      serverUpdatedAt: incoming.serverUpdatedAt,
    });
  }

  private static async acknowledgeUnchangedOutboxEntries(
    snapshot: SyncRequestSnapshot,
    acknowledged: Set<string>,
    conflicts: Set<string>,
  ) {
    for (const key of acknowledged) {
      const sent = snapshot.dirtyEntries.get(key);
      const current = await db.dirtyEntities.get(key);
      if (!sent || !current || sent.generation !== current.generation) {
        continue;
      }

      await db.dirtyEntities.delete(key);
      if (!conflicts.has(key)) {
        await db.syncConflicts.delete(key);
      }
    }
  }

  private static shouldReplaceLocal<T extends SyncItem>(local: T, incoming: T): boolean {
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

  private static async recordConflicts(response: SyncResponse, request: SyncRequest) {
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
      await db.syncConflicts.put(record);
    }
  }

  private static buildEntityMap(delta: SyncDelta): Map<string, SyncItem> {
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

  private static async getCursor(): Promise<number> {
    return (await db.syncState.get(SYNC_CURSOR_KEY))?.cursor ?? 0;
  }

  private static async listUnsyncedEntities(): Promise<Array<{ entityType: SyncEntityType; entityId: string }>> {
    const [workoutTypes, logs, workouts, profile] = await Promise.all([
      db.workoutTypes.toArray(),
      db.logs.toArray(),
      db.workouts.toArray(),
      db.profile.toArray(),
    ]);

    return [
      ...workoutTypes.filter((item) => !item.version).map((item) => ({ entityType: 'workoutTypes' as const, entityId: item.id })),
      ...logs.filter((item) => !item.version).map((item) => ({ entityType: 'logs' as const, entityId: item.id })),
      ...workouts.filter((item) => !item.version).map((item) => ({ entityType: 'workouts' as const, entityId: item.id })),
      ...profile.filter((item) => !item.version).map((item) => ({ entityType: 'profile' as const, entityId: item.id })),
    ];
  }

  private static async listAllEntityKeys(): Promise<Array<{ entityType: SyncEntityType; entityId: string }>> {
    const [workoutTypes, logs, workouts, profile] = await Promise.all([
      db.workoutTypes.toArray(),
      db.logs.toArray(),
      db.workouts.toArray(),
      db.profile.toArray(),
    ]);

    return [
      ...workoutTypes.map((item) => ({ entityType: 'workoutTypes' as const, entityId: item.id })),
      ...logs.map((item) => ({ entityType: 'logs' as const, entityId: item.id })),
      ...workouts.map((item) => ({ entityType: 'workouts' as const, entityId: item.id })),
      ...profile.map((item) => ({ entityType: 'profile' as const, entityId: item.id })),
    ];
  }
}
