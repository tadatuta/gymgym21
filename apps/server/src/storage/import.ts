import type { PoolClient } from 'pg';
import { ensureDatabaseReady, getDatabasePool } from '../database.js';
import { ensureAuthDatabaseSchema } from '../auth-meta.js';
import type { StorageWorkoutType, StorageLogEntry, StorageWorkout, StorageProfile, StorageData } from './types.js';
import { sanitizeStorageKey, cloneValue, normalizeTimestamp } from './values.js';
import { validateStorageDataShape } from './validation.js';
import { normalizeProfileForWrite } from './profile.js';
import { ensureStorageRoot, updateStorageRootRevision, upsertProfile, upsertWorkoutType, upsertWorkout, upsertLog } from './write-repository.js';
import { readImportEntities } from './read-repository.js';
import { refreshPublicAliases, invalidatePublicProfileCache } from './public-repository.js';

interface ImportedEntity<T> {
  item: T;
  version: number;
}

export function normalizeImportedData(input: StorageData): StorageData {
  validateStorageDataShape(input);
  const source = cloneValue(input);
  const now = new Date().toISOString();

  const workoutTypes = (source.workoutTypes ?? []).map((item) => ({
    ...item,
    updatedAt: normalizeTimestamp(item.updatedAt, now),
    isDeleted: item.isDeleted ?? false,
  }));
  const workouts = (source.workouts ?? []).map((item) => ({
    ...item,
    updatedAt: normalizeTimestamp(item.updatedAt, item.startTime),
    pauseIntervals: Array.isArray(item.pauseIntervals) ? item.pauseIntervals : [],
    isDeleted: item.isDeleted ?? false,
  }));
  const logs = (source.logs ?? []).map((item) => ({
    ...item,
    updatedAt: normalizeTimestamp(item.updatedAt, item.date),
    isDeleted: item.isDeleted ?? false,
  }));
  const profile = source.profile
    ? normalizeProfileForWrite(source.profile, {
        now,
      })
    : undefined;

  return {
    workoutTypes,
    workouts,
    logs,
    profile,
  };
}

export function prepareImportedSnapshot(input: StorageData): {
  revision: number;
  profile?: ImportedEntity<StorageProfile>;
  workoutTypes: ImportedEntity<StorageWorkoutType>[];
  workouts: ImportedEntity<StorageWorkout>[];
  logs: ImportedEntity<StorageLogEntry>[];
} {
  const normalized = normalizeImportedData(input);
  let revision = 0;

  const nextVersion = () => {
    revision += 1;
    return revision;
  };

  const profile = normalized.profile
    ? {
        item: {
          ...normalized.profile,
          version: nextVersion(),
          serverUpdatedAt: normalized.profile.updatedAt,
        },
        version: revision,
      }
    : undefined;

  const workoutTypes = [...(normalized.workoutTypes ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((item) => {
      const version = nextVersion();
      return {
        item: {
          ...item,
          version,
          serverUpdatedAt: item.updatedAt,
        },
        version,
      };
    });

  const workouts = [...(normalized.workouts ?? [])]
    .sort((left, right) => left.startTime.localeCompare(right.startTime) || left.id.localeCompare(right.id))
    .map((item) => {
      const version = nextVersion();
      return {
        item: {
          ...item,
          version,
          serverUpdatedAt: item.updatedAt,
        },
        version,
      };
    });

  const logs = [...(normalized.logs ?? [])]
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
    .map((item) => {
      const version = nextVersion();
      return {
        item: {
          ...item,
          version,
          serverUpdatedAt: item.updatedAt,
        },
        version,
      };
    });

  return {
    revision,
    profile,
    workoutTypes,
    workouts,
    logs,
  };
}


/** Caller owns the transaction. Never reset cursors or delete retry receipts. */
export async function replaceSnapshotTx(client: PoolClient, storageKeyInput: string | number, data: StorageData): Promise<number> {
  const storageKey = sanitizeStorageKey(storageKeyInput);
  const prepared = prepareImportedSnapshot(data);
  let revision = await ensureStorageRoot(client, storageKey);
  const now = new Date().toISOString();
  const write = async <T extends { id: string; isDeleted?: boolean }>(
    incoming: T[], existing: T[], upsert: (client: PoolClient, key: string, item: T) => Promise<void>,
  ) => {
    const ids = new Set(incoming.map((item) => item.id));
    const missing = existing.filter((item) => !item.isDeleted && !ids.has(item.id))
      .map((item) => ({ ...item, isDeleted: true }));
    for (const item of [...incoming, ...missing]) {
      revision += 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Storage revision exhausted');
      await upsert(client, storageKey, { ...item, version: revision, updatedAt: now, serverUpdatedAt: now });
    }
  };
  const { workoutTypes, workouts, logs, profile } = await readImportEntities(client, storageKey);
  await write(prepared.workoutTypes.map((entry) => entry.item), workoutTypes, upsertWorkoutType);
  await write(prepared.workouts.map((entry) => entry.item), workouts, upsertWorkout);
  await write(prepared.logs.map((entry) => entry.item), logs, upsertLog);
  // The profile is a singleton even when a legacy file used a different ID.
  const nextProfile = prepared.profile?.item;
  await write(nextProfile ? [nextProfile] : [], profile && !nextProfile ? [profile] : [], upsertProfile);
  await updateStorageRootRevision(client, storageKey, revision);
  await refreshPublicAliases(client, storageKey, nextProfile);
  await invalidatePublicProfileCache(client, storageKey);
  return revision;
}

export async function replaceSnapshot(storageKeyInput: string | number, data: StorageData): Promise<void> {
  await ensureDatabaseReady();
  const storageKey = sanitizeStorageKey(storageKeyInput);
  // Validate before opening a transaction; replacement shares the same primitive as CLI plans.
  prepareImportedSnapshot(data);
  await ensureAuthDatabaseSchema();
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN');
    await replaceSnapshotTx(client, storageKey, data);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
