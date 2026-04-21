import { authorizedApiFetch } from '../auth';
import { db } from '../db';
import {
  AppData,
  DirtyEntityRecord,
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

const SYNC_CURSOR_KEY = 'sync-cursor';
const PROFILE_ID = 'me';

type SyncEntityMap = {
  workoutTypes: WorkoutType;
  logs: WorkoutSet;
  workouts: WorkoutSession;
  profile: UserProfile;
};

type ArrayEntityType = 'workoutTypes' | 'logs' | 'workouts';

export interface SyncExecutionResult {
  cursor: number;
  conflicts: number;
  pushedEntities: number;
  pulledEntities: number;
}

function dirtyKey(entityType: SyncEntityType, entityId: string): string {
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

export class SyncService {
  static async sync(): Promise<SyncExecutionResult> {
    if (!navigator.onLine) {
      throw new Error('Offline');
    }

    const [cursor, dirtyEntries] = await Promise.all([
      this.getCursor(),
      db.dirtyEntities.toArray(),
    ]);

    const request: SyncRequest = {
      cursor,
      changes: await this.readDirtyDelta(dirtyEntries),
    };

    const response = await authorizedApiFetch('/me/storage/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Unauthorized');
      }
      throw new Error('Sync failed');
    }

    const result = await response.json() as SyncResponse;
    const pulledEntities = countDeltaEntities(result.changes);
    const pushedEntities = countDeltaEntities(request.changes);

    await this.applySyncResponse(result, request);

    return {
      cursor: result.cursor,
      conflicts: result.conflicts.length,
      pushedEntities,
      pulledEntities,
    };
  }

  static async markDirty(entityType: SyncEntityType, entityId: string) {
    const record: DirtyEntityRecord = {
      key: dirtyKey(entityType, entityId),
      entityType,
      entityId,
      queuedAt: new Date().toISOString(),
    };
    await db.dirtyEntities.put(record);
  }

  static async markDirtyMany(changes: Array<{ entityType: SyncEntityType; entityId: string }>) {
    if (changes.length === 0) {
      return;
    }

    const queuedAt = new Date().toISOString();
    await db.dirtyEntities.bulkPut(
      changes.map(({ entityType, entityId }) => ({
        key: dirtyKey(entityType, entityId),
        entityType,
        entityId,
        queuedAt,
      })),
    );
  }

  static async markAllEntitiesDirty() {
    await this.markDirtyMany(await this.listAllEntityKeys());
  }

  static async bootstrapDirtyState() {
    const [cursor, dirtyCount] = await Promise.all([
      this.getCursor(),
      db.dirtyEntities.count(),
    ]);

    if (cursor > 0 || dirtyCount > 0) {
      return;
    }

    const unsyncedEntities = await this.listUnsyncedEntities();
    if (unsyncedEntities.length === 0) {
      return;
    }

    await this.markDirtyMany(unsyncedEntities);
  }

  static async readAll(): Promise<AppData> {
    return {
      workouts: await db.workouts.toArray(),
      logs: await db.logs.toArray(),
      workoutTypes: await db.workoutTypes.toArray(),
      profile: await db.profile.get(PROFILE_ID),
    };
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

    const table = this.getArrayTable(entityType);
    const items = await table.bulkGet(ids);
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

  private static async applySyncResponse(response: SyncResponse, request: SyncRequest) {
    await db.transaction(
      'rw',
      [db.workouts, db.logs, db.workoutTypes, db.profile, db.dirtyEntities, db.syncState, db.syncConflicts],
      async () => {
        await this.applyArrayDelta('workoutTypes', response.changes.workoutTypes);
        await this.applyArrayDelta('logs', response.changes.logs);
        await this.applyArrayDelta('workouts', response.changes.workouts);

        if (response.changes.profile) {
          await this.applyProfileDelta(response.changes.profile);
        }

        await this.recordConflicts(response, request);

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
  ) {
    for (const incoming of asArray(incomingItems)) {
      const table = this.getArrayTable(entityType);
      const local = await table.get(incoming.id) as SyncEntityMap[K] | undefined;
      if (!local || this.shouldReplaceLocal(local, incoming)) {
        switch (entityType) {
          case 'workoutTypes':
            await db.workoutTypes.put(incoming as WorkoutType);
            break;
          case 'logs':
            await db.logs.put(incoming as WorkoutSet);
            break;
          case 'workouts':
            await db.workouts.put(incoming as WorkoutSession);
            break;
        }
      }
      await db.dirtyEntities.delete(dirtyKey(entityType, incoming.id));
      await db.syncConflicts.delete(dirtyKey(entityType, incoming.id));
    }
  }

  private static async applyProfileDelta(profile: UserProfile) {
    const local = await db.profile.get(PROFILE_ID);
    if (!local || this.shouldReplaceLocal(local, profile)) {
      await db.profile.put({ ...profile, id: PROFILE_ID });
    }
    await db.dirtyEntities.delete(dirtyKey('profile', PROFILE_ID));
    await db.syncConflicts.delete(dirtyKey('profile', PROFILE_ID));
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
