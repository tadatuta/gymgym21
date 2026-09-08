import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { ensureDatabaseReady, getDatabasePool } from '../database.js';
import { HttpError } from '../http/errors.js';
import type { StorageProfile, StorageData, StorageSyncResponse, AIStorageContext } from './types.js';
import type { RevisionRow, RootRow, ChangedEntityRow, StorageProfileRow, StorageWorkoutTypeRow, StorageWorkoutRow, StorageLogRow } from './rows.js';
import { sanitizeStorageKey, toNumber } from './values.js';
import { mapProfileRow, mapWorkoutTypeRow, mapWorkoutRow, mapLogRow } from './row-mappers.js';

export async function readExistingArrayEntityMap<T extends StorageWorkoutTypeRow | StorageWorkoutRow | StorageLogRow>(
  client: PoolClient,
  storageKey: string,
  table: 'storage_workout_types' | 'storage_workouts' | 'storage_logs',
  ids: string[],
): Promise<Map<string, T>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await client.query<T>(
    `SELECT * FROM ${table} WHERE storage_key = $1 AND id = ANY($2::text[])`,
    [storageKey, ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

export async function readExistingProfile(client: PoolClient, storageKey: string): Promise<StorageProfile | undefined> {
  const result = await client.query<StorageProfileRow>(
    'SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1',
    [storageKey],
  );
  return mapProfileRow(result.rows[0]);
}

export async function readPagedSyncChanges(
  client: PoolClient,
  storageKey: string,
  cursor: number,
  revision: number,
  limit: number,
): Promise<Pick<StorageSyncResponse, 'cursor' | 'changes' | 'hasMore'>> {
  const changedResult = await client.query<ChangedEntityRow>(
    `
      SELECT entity_type, entity_id, version
      FROM (
        SELECT 'profile'::text AS entity_type, profile_id AS entity_id, version
        FROM storage_profiles
        WHERE storage_key = $1 AND version > $2
        UNION ALL
        SELECT 'workoutTypes'::text AS entity_type, id AS entity_id, version
        FROM storage_workout_types
        WHERE storage_key = $1 AND version > $2
        UNION ALL
        SELECT 'workouts'::text AS entity_type, id AS entity_id, version
        FROM storage_workouts
        WHERE storage_key = $1 AND version > $2
        UNION ALL
        SELECT 'logs'::text AS entity_type, id AS entity_id, version
        FROM storage_logs
        WHERE storage_key = $1 AND version > $2
      ) AS changed_entities
      ORDER BY version ASC
      LIMIT $3
    `,
    [storageKey, cursor, limit + 1],
  );
  const hasMore = changedResult.rows.length > limit;
  const selected = changedResult.rows.slice(0, limit);
  const idsByType = {
    workoutTypes: selected.filter((entry) => entry.entity_type === 'workoutTypes').map((entry) => entry.entity_id),
    workouts: selected.filter((entry) => entry.entity_type === 'workouts').map((entry) => entry.entity_id),
    logs: selected.filter((entry) => entry.entity_type === 'logs').map((entry) => entry.entity_id),
  };
  const includesProfile = selected.some((entry) => entry.entity_type === 'profile');

  const [profileResult, workoutTypeResult, workoutResult, logResult] = await Promise.all([
    includesProfile
      ? client.query<StorageProfileRow>('SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1', [storageKey])
      : Promise.resolve({ rows: [] as StorageProfileRow[] }),
    idsByType.workoutTypes.length > 0
      ? client.query<StorageWorkoutTypeRow>(
          'SELECT * FROM storage_workout_types WHERE storage_key = $1 AND id = ANY($2::text[]) ORDER BY version ASC',
          [storageKey, idsByType.workoutTypes],
        )
      : Promise.resolve({ rows: [] as StorageWorkoutTypeRow[] }),
    idsByType.workouts.length > 0
      ? client.query<StorageWorkoutRow>(
          'SELECT * FROM storage_workouts WHERE storage_key = $1 AND id = ANY($2::text[]) ORDER BY version ASC',
          [storageKey, idsByType.workouts],
        )
      : Promise.resolve({ rows: [] as StorageWorkoutRow[] }),
    idsByType.logs.length > 0
      ? client.query<StorageLogRow>(
          'SELECT * FROM storage_logs WHERE storage_key = $1 AND id = ANY($2::text[]) ORDER BY version ASC',
          [storageKey, idsByType.logs],
        )
      : Promise.resolve({ rows: [] as StorageLogRow[] }),
  ]);

  return {
    cursor: selected.length > 0 ? toNumber(selected.at(-1)!.version) : revision,
    hasMore,
    changes: {
      workoutTypes: workoutTypeResult.rows.map(mapWorkoutTypeRow),
      workouts: workoutResult.rows.map(mapWorkoutRow),
      logs: logResult.rows.map(mapLogRow),
      profile: mapProfileRow(profileResult.rows[0]) ?? null,
    },
  };
}

export async function readSnapshot(storageKeyInput: string | number): Promise<StorageData> {
  await ensureDatabaseReady();
  const storageKey = sanitizeStorageKey(storageKeyInput);
  const pool = getDatabasePool();

  const [rootResult, profileResult, workoutTypeResult, workoutResult, logResult] = await Promise.all([
    pool.query<RootRow>('SELECT server_revision FROM storage_roots WHERE storage_key = $1 LIMIT 1', [storageKey]),
    pool.query<StorageProfileRow>('SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1', [storageKey]),
    pool.query<StorageWorkoutTypeRow>(
      'SELECT * FROM storage_workout_types WHERE storage_key = $1 ORDER BY version ASC, id ASC',
      [storageKey],
    ),
    pool.query<StorageWorkoutRow>(
      'SELECT * FROM storage_workouts WHERE storage_key = $1 ORDER BY version ASC, start_time ASC, id ASC',
      [storageKey],
    ),
    pool.query<StorageLogRow>(
      'SELECT * FROM storage_logs WHERE storage_key = $1 ORDER BY version ASC, logged_at ASC, id ASC',
      [storageKey],
    ),
  ]);

  return {
    revision: toNumber(rootResult.rows[0]?.server_revision),
    profile: mapProfileRow(profileResult.rows[0]),
    workoutTypes: workoutTypeResult.rows.map(mapWorkoutTypeRow),
    workouts: workoutResult.rows.map(mapWorkoutRow),
    logs: logResult.rows.map(mapLogRow),
  };
}

export async function readAiContext(storageKeyInput: string | number, expectedRevision?: number): Promise<AIStorageContext> {
  await ensureDatabaseReady();
  const storageKey = sanitizeStorageKey(storageKeyInput);
  const client = await getDatabasePool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const root = await client.query<RevisionRow>('SELECT server_revision FROM storage_roots WHERE storage_key = $1', [storageKey]);
    if (expectedRevision !== undefined && toNumber(root.rows[0]?.server_revision) !== expectedRevision) {
      throw new HttpError(409, 'AI context changed; sync and retry', { code: 'AI_CONTEXT_STALE' });
    }

    const profileResult = await client.query<StorageProfileRow>('SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1', [storageKey]);
    const workoutTypeResult = await client.query<StorageWorkoutTypeRow>(
      'SELECT * FROM storage_workout_types WHERE storage_key = $1 AND is_deleted = FALSE ORDER BY updated_at DESC, id ASC LIMIT $2', [storageKey, config.AI_MAX_EXERCISE_COUNT],
    );
    const logResult = await client.query<StorageLogRow>(
      'SELECT * FROM storage_logs WHERE storage_key = $1 AND is_deleted = FALSE ORDER BY logged_at DESC, id ASC LIMIT $2', [storageKey, config.AI_MAX_RECENT_LOGS],
    );

    await client.query('COMMIT');
    return {
      profile: mapProfileRow(profileResult.rows[0]),
      workoutTypes: workoutTypeResult.rows.map(mapWorkoutTypeRow),
      logs: logResult.rows.map(mapLogRow).reverse(),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}


/** Full delta is used only by the bounded backup import contract. */
export async function readBackupChanges(client: PoolClient, storageKey: string, cursor: number, revision: number): Promise<Pick<StorageSyncResponse, 'cursor' | 'changes' | 'hasMore'>> {
  const [profileResult, workoutTypeResult, workoutResult, logResult] = await Promise.all([
    client.query<StorageProfileRow>(
      'SELECT * FROM storage_profiles WHERE storage_key = $1 AND version > $2 ORDER BY version ASC LIMIT 1',
      [storageKey, cursor],
    ),
    client.query<StorageWorkoutTypeRow>(
      'SELECT * FROM storage_workout_types WHERE storage_key = $1 AND version > $2 ORDER BY version ASC',
      [storageKey, cursor],
    ),
    client.query<StorageWorkoutRow>(
      'SELECT * FROM storage_workouts WHERE storage_key = $1 AND version > $2 ORDER BY version ASC',
      [storageKey, cursor],
    ),
    client.query<StorageLogRow>(
      'SELECT * FROM storage_logs WHERE storage_key = $1 AND version > $2 ORDER BY version ASC',
      [storageKey, cursor],
    ),
  ]);
  return {
    cursor: revision,
    hasMore: false,
    changes: {
      workoutTypes: workoutTypeResult.rows.map(mapWorkoutTypeRow),
      workouts: workoutResult.rows.map(mapWorkoutRow),
      logs: logResult.rows.map(mapLogRow),
      profile: mapProfileRow(profileResult.rows[0]) ?? null,
    },
  };
}

export async function readImportEntities(client: PoolClient, storageKey: string) {
  const types = await client.query<StorageWorkoutTypeRow>('SELECT * FROM storage_workout_types WHERE storage_key = $1', [storageKey]);
  const workouts = await client.query<StorageWorkoutRow>('SELECT * FROM storage_workouts WHERE storage_key = $1', [storageKey]);
  const logs = await client.query<StorageLogRow>('SELECT * FROM storage_logs WHERE storage_key = $1', [storageKey]);
  const profile = await readExistingProfile(client, storageKey);
  return { workoutTypes: types.rows.map(mapWorkoutTypeRow), workouts: workouts.rows.map(mapWorkoutRow), logs: logs.rows.map(mapLogRow), profile };
}
