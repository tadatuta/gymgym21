import { readSyncReceipt, writeSyncReceipt } from './receipt-repository.js';
import { syncEntityContentEqual } from '@gym21/contracts';
import type { PoolClient } from 'pg';
import { ensureDatabaseReady, getDatabasePool } from '../database.js';
import type { AuthenticatedRequestContext } from '../auth.js';
import { HttpError } from '../http/errors.js';
import type { StorageWorkoutType, StorageLogEntry, StorageWorkout, StorageProfile, SyncConflict, SyncAcknowledgement, StorageSyncRequest, StorageSyncResponse } from './types.js';
import type { SyncPushReceipt, StorageWorkoutTypeRow, StorageWorkoutRow, StorageLogRow } from './rows.js';
import { STORAGE_PROFILE_ID, sanitizeStorageKey, cloneValue, toNumber, normalizeTimestamp } from './values.js';
import { validateSyncRequest } from './validation.js';
import { normalizeProfileForWrite } from './profile.js';
import { mapWorkoutTypeRow, mapWorkoutRow, mapLogRow } from './row-mappers.js';
import { ensureStorageRoot, updateStorageRootRevision, upsertProfile, upsertWorkoutType, upsertWorkout, upsertLog } from './write-repository.js';
import { readExistingArrayEntityMap, readExistingProfile, readPagedSyncChanges, readBackupChanges, readImportEntities } from './read-repository.js';
import { refreshPublicAliases, invalidatePublicProfileCache } from './public-repository.js';

export function mergeConflictEntity<T extends StorageWorkoutType | StorageWorkout | StorageLogEntry>(
  items: T[],
  entity: T,
): T[] {
  const index = items.findIndex((entry) => entry.id === entity.id);
  if (index >= 0) {
    const next = [...items];
    next[index] = entity;
    return next;
  }
  return [...items, entity].sort((left, right) => (left.version ?? 0) - (right.version ?? 0));
}

export function listSyncAcknowledgements(changes: StorageSyncRequest['changes']): SyncAcknowledgement[] {
  const entries: SyncAcknowledgement[] = [
    ...(changes.workoutTypes ?? []).map((entry) => ({
      entityType: 'workoutTypes' as const,
      entityId: entry.id,
    })),
    ...(changes.logs ?? []).map((entry) => ({
      entityType: 'logs' as const,
      entityId: entry.id,
    })),
    ...(changes.workouts ?? []).map((entry) => ({
      entityType: 'workouts' as const,
      entityId: entry.id,
    })),
    ...(changes.profile
      ? [{
          entityType: 'profile' as const,
          entityId: changes.profile.id,
        }]
      : []),
  ];

  return [...new Map(entries.map((entry) => [
    `${entry.entityType}:${entry.entityId}`,
    entry,
  ])).values()];
}

export function hasOutgoingSyncChanges(changes: StorageSyncRequest['changes']): boolean {
  return Boolean(
    changes.profile
    || changes.workoutTypes?.length
    || changes.logs?.length
    || changes.workouts?.length,
  );
}

/** Shared optimistic-write algorithm; SQL and normalization stay entity-specific. */
async function applyArrayChanges<T extends StorageWorkoutType | StorageWorkout | StorageLogEntry, R extends { version: string | number }>(
  client: PoolClient,
  storageKey: string,
  entityType: 'workoutTypes' | 'workouts' | 'logs',
  incomingItems: T[],
  existingItems: Map<string, R>,
  revision: number,
  mapRow: (row: R) => T,
  upsert: (client: PoolClient, storageKey: string, item: T) => Promise<void>,
  normalize: (incoming: T) => T,
): Promise<{ revision: number; changed: boolean; conflicts: SyncConflict[]; authoritative: T[]; equivalent: number }> {
  const conflicts: SyncConflict[] = [];
  let authoritative: T[] = [];
  let changed = false;
  let equivalent = 0;
  for (const incoming of incomingItems) {
    const existing = existingItems.get(incoming.id);
    const existingVersion = existing ? toNumber(existing.version) : 0;
    if (existing && (incoming.version ?? 0) !== existingVersion) {
      if (syncEntityContentEqual(entityType, normalize(incoming), mapRow(existing))) {
        equivalent += 1;
        authoritative = mergeConflictEntity(authoritative, mapRow(existing));
        continue;
      }
      conflicts.push({ entityType, entityId: incoming.id, reason: 'stale-version', serverVersion: existingVersion });
      authoritative = mergeConflictEntity(authoritative, mapRow(existing));
      continue;
    }
    if (!existing && incoming.isDeleted) continue;
    revision += 1;
    await upsert(client, storageKey, {
      ...normalize(incoming),
      isDeleted: incoming.isDeleted ?? false,
      version: revision,
      serverUpdatedAt: new Date().toISOString(),
    });
    changed = true;
  }
  return { revision, changed, conflicts, authoritative, equivalent };
}

export async function sync(
  storageKeyInput: string | number,
  request: StorageSyncRequest,
  authContext: AuthenticatedRequestContext,
  backup?: { mode: 'merge' | 'replace'; expectedRevision: number },
): Promise<StorageSyncResponse> {
  await ensureDatabaseReady();
  validateSyncRequest(request, Boolean(backup));
  const storageKey = sanitizeStorageKey(storageKeyInput);
  const client = await getDatabasePool().connect();

  try {
    await client.query('BEGIN');
    let revision = await ensureStorageRoot(client, storageKey);
    if (backup) {
      if (backup.expectedRevision !== revision) {
        throw new HttpError(409, 'Storage changed; synchronize and review the backup import again', { code: 'backup_revision_conflict' });
      }
      // The root lock covers the revision check, rebasing and every tombstone write.
      // Backup versions never participate in sync conflict detection.
      const normalize = <T extends { id: string; version?: number; serverUpdatedAt?: string; updatedAt?: string; isDeleted?: boolean }>(incoming: T[], existing: T[]): T[] => {
        const versions = new Map(existing.map((item) => [item.id, item.version]));
        const active = incoming.filter((item) => !item.isDeleted).map((item) => ({
          ...item, version: versions.get(item.id) ?? 0, serverUpdatedAt: undefined,
          updatedAt: new Date().toISOString(), isDeleted: false,
        }));
        const ids = new Set(active.map((item) => item.id));
        return backup.mode === 'merge' ? active : [...active, ...existing.filter((item) => !item.isDeleted && !ids.has(item.id)).map((item) => ({
          ...item, isDeleted: true, updatedAt: new Date().toISOString(),
        }))];
      };
      const existing = await readImportEntities(client, storageKey);
      request = { protocolVersion: 1, cursor: request.cursor, changes: {
        workoutTypes: normalize(request.changes.workoutTypes ?? [], existing.workoutTypes),
        workouts: normalize(request.changes.workouts ?? [], existing.workouts),
        logs: normalize(request.changes.logs ?? [], existing.logs),
        profile: normalize(request.changes.profile ? [{ ...request.changes.profile, id: STORAGE_PROFILE_ID }] : [], existing.profile ? [existing.profile] : [])[0],
      } };
    }
    const hasPush = hasOutgoingSyncChanges(request.changes);
    let receipt: SyncPushReceipt | undefined;
    if (hasPush && request.batchId) {
      receipt = await readSyncReceipt(client, storageKey, request.batchId);
    }

    const conflicts: SyncConflict[] = receipt?.conflicts.map((conflict) => ({ ...conflict })) ?? [];
    let equivalent = 0;
    let profileChanged = false;
    let workoutTypesChanged = false;
    let logsChanged = false;
    let authoritativeProfile: StorageProfile | null = null;
    let authoritativeWorkoutTypes: StorageWorkoutType[] = [];
    let authoritativeWorkouts: StorageWorkout[] = [];
    let authoritativeLogs: StorageLogEntry[] = [];

    const existingWorkoutTypes = await readExistingArrayEntityMap<StorageWorkoutTypeRow>(
      client,
      storageKey,
      'storage_workout_types',
      (request.changes.workoutTypes ?? []).map((entry) => entry.id),
    );
    const existingWorkouts = await readExistingArrayEntityMap<StorageWorkoutRow>(
      client,
      storageKey,
      'storage_workouts',
      (request.changes.workouts ?? []).map((entry) => entry.id),
    );
    const existingLogs = await readExistingArrayEntityMap<StorageLogRow>(
      client,
      storageKey,
      'storage_logs',
      (request.changes.logs ?? []).map((entry) => entry.id),
    );
    const existingProfile = await readExistingProfile(client, storageKey);

    if (!receipt) {
      // The order determines global server revisions and must remain stable.
      const typesResult = await applyArrayChanges(client, storageKey, 'workoutTypes', request.changes.workoutTypes ?? [], existingWorkoutTypes, revision, mapWorkoutTypeRow, upsertWorkoutType,
        (incoming) => ({ ...incoming, updatedAt: normalizeTimestamp(incoming.updatedAt, new Date().toISOString()) }));
      revision = typesResult.revision;
      workoutTypesChanged = typesResult.changed;
      const workoutsResult = await applyArrayChanges(client, storageKey, 'workouts', request.changes.workouts ?? [], existingWorkouts, revision, mapWorkoutRow, upsertWorkout,
        (incoming) => ({ ...incoming, pauseIntervals: Array.isArray(incoming.pauseIntervals) ? cloneValue(incoming.pauseIntervals) : [], updatedAt: normalizeTimestamp(incoming.updatedAt, incoming.startTime) }));
      revision = workoutsResult.revision;
      const logsResult = await applyArrayChanges(client, storageKey, 'logs', request.changes.logs ?? [], existingLogs, revision, mapLogRow, upsertLog,
        (incoming) => ({ ...incoming, updatedAt: normalizeTimestamp(incoming.updatedAt, incoming.date) }));
      revision = logsResult.revision;
      logsChanged = logsResult.changed;
      conflicts.push(...typesResult.conflicts, ...workoutsResult.conflicts, ...logsResult.conflicts);
      equivalent = typesResult.equivalent + workoutsResult.equivalent + logsResult.equivalent;
      authoritativeWorkoutTypes = typesResult.authoritative;
      authoritativeWorkouts = workoutsResult.authoritative;
      authoritativeLogs = logsResult.authoritative;

      if (request.changes.profile) {
        const incoming = normalizeProfileForWrite(request.changes.profile, {
          existing: existingProfile,
          authContext,
        });
        const existingVersion = existingProfile?.version ?? 0;

        if (existingProfile && (request.changes.profile.version ?? 0) !== existingVersion) {
          if (syncEntityContentEqual('profile', incoming, existingProfile)) equivalent += 1;
          if (!syncEntityContentEqual('profile', incoming, existingProfile)) conflicts.push({
            entityType: 'profile',
            entityId: existingProfile.id,
            reason: 'stale-version',
            serverVersion: existingVersion,
          });
          authoritativeProfile = existingProfile;
        } else {
          revision += 1;
          incoming.version = revision;
          incoming.serverUpdatedAt = incoming.updatedAt;
          await upsertProfile(client, storageKey, incoming);
          profileChanged = true;
        }
      }

      await updateStorageRootRevision(client, storageKey, revision);

      if (profileChanged || !existingProfile) {
        const nextProfile = await readExistingProfile(client, storageKey);
        await refreshPublicAliases(client, storageKey, nextProfile);
      }

      if (profileChanged || workoutTypesChanged || logsChanged) {
        await invalidatePublicProfileCache(client, storageKey);
      }
    } else {
      // Include current submitted entities even if the caller advanced its cursor.
      // Clients need their server versions to rebase edits made while the push was in flight.
      authoritativeProfile = request.changes.profile ? existingProfile ?? null : null;
      authoritativeWorkoutTypes = [...existingWorkoutTypes.values()].map(mapWorkoutTypeRow);
      authoritativeWorkouts = [...existingWorkouts.values()].map(mapWorkoutRow);
      authoritativeLogs = [...existingLogs.values()].map(mapLogRow);
      for (const conflict of conflicts) {
        const current = conflict.entityType === 'profile' ? authoritativeProfile
          : conflict.entityType === 'workoutTypes' ? existingWorkoutTypes.get(conflict.entityId)
          : conflict.entityType === 'workouts' ? existingWorkouts.get(conflict.entityId)
          : existingLogs.get(conflict.entityId);
        if (current) {
          conflict.serverVersion = toNumber(current.version);
        }
      }
    }

    // A push's authoritative versions are separate from cursor pagination. Including
    // them must never advance past unseen remote changes. Bound: page + submitted.
    if (hasPush && !receipt && !backup) {
      authoritativeWorkoutTypes = [...(await readExistingArrayEntityMap<StorageWorkoutTypeRow>(client, storageKey, 'storage_workout_types', (request.changes.workoutTypes ?? []).map((x) => x.id))).values()].map(mapWorkoutTypeRow);
      authoritativeWorkouts = [...(await readExistingArrayEntityMap<StorageWorkoutRow>(client, storageKey, 'storage_workouts', (request.changes.workouts ?? []).map((x) => x.id))).values()].map(mapWorkoutRow);
      authoritativeLogs = [...(await readExistingArrayEntityMap<StorageLogRow>(client, storageKey, 'storage_logs', (request.changes.logs ?? []).map((x) => x.id))).values()].map(mapLogRow);
      authoritativeProfile = request.changes.profile ? await readExistingProfile(client, storageKey) ?? null : null;
    }

    let pulled: Pick<StorageSyncResponse, 'cursor' | 'changes' | 'hasMore'>;
    if (!backup) {
      pulled = await readPagedSyncChanges(client, storageKey, request.cursor, revision, request.limit ?? 1000);
    } else {
      pulled = await readBackupChanges(client, storageKey, request.cursor, revision);
    }

    const response: StorageSyncResponse = {
      cursor: pulled.cursor,
      changes: pulled.changes,
      conflicts,
      acknowledged: receipt?.acknowledged ?? listSyncAcknowledgements(request.changes),
      protocolVersion: 1,
      hasMore: pulled.hasMore,
    };

    if (authoritativeProfile && (!response.changes.profile || response.changes.profile.id === authoritativeProfile.id)) {
      response.changes.profile = authoritativeProfile;
    }
    for (const entry of authoritativeWorkoutTypes) {
      response.changes.workoutTypes = mergeConflictEntity(response.changes.workoutTypes, entry);
    }
    for (const entry of authoritativeWorkouts) {
      response.changes.workouts = mergeConflictEntity(response.changes.workouts, entry);
    }
    for (const entry of authoritativeLogs) {
      response.changes.logs = mergeConflictEntity(response.changes.logs, entry);
    }

    if (hasPush && request.batchId && !receipt) {
      await writeSyncReceipt(client, storageKey, request.batchId, { conflicts: response.conflicts, acknowledged: response.acknowledged });
    }

    await client.query('COMMIT');
    if (equivalent) console.info('[sync] acknowledged equivalent stale records', { count: equivalent });
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
