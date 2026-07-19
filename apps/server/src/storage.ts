import type { PoolClient } from 'pg';
import { config } from './config.js';
import { ensureDatabaseReady, getDatabasePool } from './database.js';
import type { AuthenticatedRequestContext } from './auth.js';
import { HttpError } from './http/errors.js';

const ARRAY_ENTITY_TYPES = ['workoutTypes', 'logs', 'workouts'] as const;
const STORAGE_PROFILE_ID = 'me';
const MAX_NAME_LENGTH = 100;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_LOG_COUNT = 10000;

type ArrayEntityType = (typeof ARRAY_ENTITY_TYPES)[number];

interface RevisionRow {
  server_revision: string | number;
}

interface AliasRow {
  storage_key: string;
}

interface CacheRow {
  source_revision: string | number;
  payload: PublicProfileData;
}

interface RootRow {
  server_revision: string | number;
}

interface ChangedEntityRow {
  entity_type: SyncEntityType;
  entity_id: string;
  version: string | number;
}

interface SyncReceiptRow {
  response_payload: StorageSyncResponse | string;
}

interface StorageProfileRow {
  profile_id: string;
  is_public: boolean;
  show_full_history: boolean;
  display_name: string | null;
  username: string | null;
  telegram_username: string | null;
  telegram_user_id: string | number | null;
  photo_url: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  is_deleted: boolean;
  gender: 'male' | 'female' | 'other' | null;
  birth_date: string | Date | null;
  height: number | null;
  weight: number | null;
  additional_info: string | null;
  friends_json: StorageFriend[] | null;
  version: string | number;
  server_updated_at: string | Date;
}

interface StorageWorkoutTypeRow {
  id: string;
  name: string;
  category: 'strength' | 'time' | null;
  sort_order: number | null;
  updated_at: string | Date;
  is_deleted: boolean;
  version: string | number;
  server_updated_at: string | Date;
}

interface StorageWorkoutRow {
  id: string;
  start_time: string | Date;
  end_time: string | Date | null;
  name: string | null;
  status: string;
  is_manual: boolean;
  pause_intervals_json: StoragePauseInterval[] | null;
  updated_at: string | Date;
  is_deleted: boolean;
  version: string | number;
  server_updated_at: string | Date;
}

interface StorageLogRow {
  id: string;
  workout_type_id: string;
  workout_id: string | null;
  reps: number | null;
  weight: number | null;
  duration: number | null;
  duration_seconds: number | null;
  logged_at: string | Date;
  updated_at: string | Date;
  is_deleted: boolean;
  version: string | number;
  server_updated_at: string | Date;
}

interface ImportedEntity<T> {
  item: T;
  version: number;
}

function sanitizeStorageKey(storageKey: string | number): string {
  const sanitized = String(storageKey).trim();
  if (!sanitized || !/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
    throw new HttpError(400, 'Invalid storage key');
  }
  return sanitized;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAlias(alias: string): string {
  return alias.trim().replace(/^@/, '').toLowerCase();
}

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string' && value.length > 0) {
    return Number(value);
  }

  return 0;
}

function toIsoString(value: string | Date | null | undefined, fallback?: string): string {
  if (!value) {
    if (!fallback) {
      return new Date().toISOString();
    }
    return fallback;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    if (fallback) {
      return fallback;
    }
    throw new HttpError(400, 'Invalid timestamp');
  }

  return date.toISOString();
}

function normalizeTimestamp(candidate: string | undefined, fallback: string): string {
  return candidate ? toIsoString(candidate, fallback) : fallback;
}

function defaultSyncChanges(): StorageSyncResponse['changes'] {
  return {
    workoutTypes: [],
    logs: [],
    workouts: [],
    profile: null,
  };
}

function validateStorageDataShape(data: StorageData) {
  if (data.workoutTypes !== undefined && !Array.isArray(data.workoutTypes)) {
    throw new HttpError(400, 'workoutTypes must be an array');
  }

  if (data.logs !== undefined && !Array.isArray(data.logs)) {
    throw new HttpError(400, 'logs must be an array');
  }

  if (data.workouts !== undefined && !Array.isArray(data.workouts)) {
    throw new HttpError(400, 'workouts must be an array');
  }

  if (data.profile !== undefined && data.profile !== null && !isRecord(data.profile)) {
    throw new HttpError(400, 'profile must be an object');
  }

  for (const workoutType of data.workoutTypes ?? []) {
    if (!workoutType.id || !workoutType.name) {
      throw new HttpError(400, 'Workout type requires id and name');
    }

    if (workoutType.name.length > MAX_NAME_LENGTH) {
      throw new HttpError(400, 'Workout type name too long');
    }
  }

  if ((data.logs?.length ?? 0) > MAX_LOG_COUNT) {
    throw new HttpError(400, 'Too many log entries');
  }

  if (data.profile?.displayName && data.profile.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new HttpError(400, 'Display name too long');
  }
}

function validateSyncRequest(request: StorageSyncRequest) {
  if (!Number.isInteger(request.cursor) || request.cursor < 0) {
    throw new HttpError(400, 'cursor must be a non-negative integer');
  }
  if (request.batchId && !/^[a-zA-Z0-9_-]{1,100}$/.test(request.batchId)) {
    throw new HttpError(400, 'batchId is invalid');
  }

  const dataForValidation: StorageData = {
    workoutTypes: request.changes.workoutTypes,
    logs: request.changes.logs,
    workouts: request.changes.workouts,
    ...(request.changes.profile ? { profile: request.changes.profile } : {}),
  };

  validateStorageDataShape(dataForValidation);
}

function parseSyncReceiptPayload(payload: StorageSyncResponse | string): StorageSyncResponse {
  return typeof payload === 'string'
    ? JSON.parse(payload) as StorageSyncResponse
    : payload;
}

function normalizeProfileForWrite(
  profile: StorageProfile,
  options: {
    existing?: StorageProfile;
    authContext?: AuthenticatedRequestContext;
    now?: string;
  } = {},
): StorageProfile {
  const now = options.now ?? new Date().toISOString();
  const existing = options.existing;
  const normalized: StorageProfile = {
    ...cloneValue(profile),
    id: profile.id || existing?.id || STORAGE_PROFILE_ID,
    isPublic: profile.isPublic ?? existing?.isPublic ?? false,
    showFullHistory: profile.showFullHistory ?? existing?.showFullHistory ?? false,
    createdAt: normalizeTimestamp(profile.createdAt || existing?.createdAt, now),
    updatedAt: normalizeTimestamp(profile.updatedAt || existing?.updatedAt, now),
    friends: Array.isArray(profile.friends) ? cloneValue(profile.friends) : cloneValue(existing?.friends ?? []),
    isDeleted: profile.isDeleted ?? false,
    version: profile.version,
    serverUpdatedAt: profile.serverUpdatedAt,
  };

  if (options.authContext?.authUser?.username) {
    normalized.username = options.authContext.authUser.username;
  }

  if (!normalized.displayName && options.authContext?.authUser?.name) {
    normalized.displayName = options.authContext.authUser.name;
  }

  if (!normalized.photoUrl && options.authContext?.authUser?.image) {
    normalized.photoUrl = options.authContext.authUser.image;
  }

  if (options.authContext?.telegramUser) {
    normalized.telegramUserId = options.authContext.telegramUser.id;
    if (options.authContext.telegramUser.username) {
      normalized.telegramUsername = options.authContext.telegramUser.username;
    }
    if (options.authContext.telegramUser.photo_url) {
      normalized.photoUrl = options.authContext.telegramUser.photo_url;
    }
  }

  normalized.updatedAt = now;
  normalized.serverUpdatedAt = now;
  return normalized;
}

function mapProfileRow(row: StorageProfileRow | undefined): StorageProfile | undefined {
  if (!row) {
    return undefined;
  }

  return {
    id: row.profile_id,
    isPublic: row.is_public,
    showFullHistory: row.show_full_history,
    displayName: row.display_name ?? undefined,
    username: row.username ?? undefined,
    telegramUsername: row.telegram_username ?? undefined,
    telegramUserId: row.telegram_user_id == null ? undefined : toNumber(row.telegram_user_id),
    photoUrl: row.photo_url ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    isDeleted: row.is_deleted,
    gender: row.gender ?? undefined,
    birthDate: row.birth_date ? toIsoString(row.birth_date).slice(0, 10) : undefined,
    height: row.height ?? undefined,
    weight: row.weight ?? undefined,
    additionalInfo: row.additional_info ?? undefined,
    friends: Array.isArray(row.friends_json) ? cloneValue(row.friends_json) : [],
    version: toNumber(row.version),
    serverUpdatedAt: toIsoString(row.server_updated_at),
  };
}

function mapWorkoutTypeRow(row: StorageWorkoutTypeRow): StorageWorkoutType {
  return {
    id: row.id,
    name: row.name,
    category: row.category ?? undefined,
    order: row.sort_order ?? undefined,
    updatedAt: toIsoString(row.updated_at),
    isDeleted: row.is_deleted,
    version: toNumber(row.version),
    serverUpdatedAt: toIsoString(row.server_updated_at),
  };
}

function mapWorkoutRow(row: StorageWorkoutRow): StorageWorkout {
  return {
    id: row.id,
    startTime: toIsoString(row.start_time),
    endTime: row.end_time ? toIsoString(row.end_time) : undefined,
    name: row.name ?? undefined,
    status: row.status,
    isManual: row.is_manual,
    pauseIntervals: Array.isArray(row.pause_intervals_json) ? cloneValue(row.pause_intervals_json) : [],
    updatedAt: toIsoString(row.updated_at),
    isDeleted: row.is_deleted,
    version: toNumber(row.version),
    serverUpdatedAt: toIsoString(row.server_updated_at),
  };
}

function mapLogRow(row: StorageLogRow): StorageLogEntry {
  return {
    id: row.id,
    workoutTypeId: row.workout_type_id,
    workoutId: row.workout_id ?? undefined,
    reps: row.reps ?? undefined,
    weight: row.weight ?? undefined,
    duration: row.duration ?? undefined,
    durationSeconds: row.duration_seconds ?? undefined,
    date: toIsoString(row.logged_at),
    updatedAt: toIsoString(row.updated_at),
    isDeleted: row.is_deleted,
    version: toNumber(row.version),
    serverUpdatedAt: toIsoString(row.server_updated_at),
  };
}

function normalizeImportedData(input: StorageData): StorageData {
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

function prepareImportedSnapshot(input: StorageData): {
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

async function ensureStorageRoot(client: PoolClient, storageKey: string): Promise<number> {
  await client.query(
    `
      INSERT INTO storage_roots (storage_key)
      VALUES ($1)
      ON CONFLICT (storage_key) DO NOTHING
    `,
    [storageKey],
  );

  const result = await client.query<RevisionRow>(
    `
      SELECT server_revision
      FROM storage_roots
      WHERE storage_key = $1
      FOR UPDATE
    `,
    [storageKey],
  );

  return toNumber(result.rows[0]?.server_revision);
}

async function updateStorageRootRevision(client: PoolClient, storageKey: string, revision: number) {
  await client.query(
    `
      UPDATE storage_roots
      SET server_revision = $2, updated_at = NOW()
      WHERE storage_key = $1
    `,
    [storageKey, revision],
  );
}

async function readExistingArrayEntityMap<T extends StorageWorkoutTypeRow | StorageWorkoutRow | StorageLogRow>(
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

async function readExistingProfile(client: PoolClient, storageKey: string): Promise<StorageProfile | undefined> {
  const result = await client.query<StorageProfileRow>(
    'SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1',
    [storageKey],
  );
  return mapProfileRow(result.rows[0]);
}

async function upsertProfile(client: PoolClient, storageKey: string, profile: StorageProfile) {
  await client.query(
    `
      INSERT INTO storage_profiles (
        storage_key,
        profile_id,
        is_public,
        show_full_history,
        display_name,
        username,
        telegram_username,
        telegram_user_id,
        photo_url,
        created_at,
        updated_at,
        is_deleted,
        gender,
        birth_date,
        height,
        weight,
        additional_info,
        friends_json,
        version,
        server_updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10::timestamptz, $11::timestamptz, $12, $13, $14::date, $15, $16, $17, $18::jsonb, $19, $20::timestamptz
      )
      ON CONFLICT (storage_key)
      DO UPDATE SET
        profile_id = EXCLUDED.profile_id,
        is_public = EXCLUDED.is_public,
        show_full_history = EXCLUDED.show_full_history,
        display_name = EXCLUDED.display_name,
        username = EXCLUDED.username,
        telegram_username = EXCLUDED.telegram_username,
        telegram_user_id = EXCLUDED.telegram_user_id,
        photo_url = EXCLUDED.photo_url,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        is_deleted = EXCLUDED.is_deleted,
        gender = EXCLUDED.gender,
        birth_date = EXCLUDED.birth_date,
        height = EXCLUDED.height,
        weight = EXCLUDED.weight,
        additional_info = EXCLUDED.additional_info,
        friends_json = EXCLUDED.friends_json,
        version = EXCLUDED.version,
        server_updated_at = EXCLUDED.server_updated_at
    `,
    [
      storageKey,
      profile.id,
      profile.isPublic,
      profile.showFullHistory ?? false,
      profile.displayName ?? null,
      profile.username ?? null,
      profile.telegramUsername ?? null,
      profile.telegramUserId ?? null,
      profile.photoUrl ?? null,
      toIsoString(profile.createdAt),
      toIsoString(profile.updatedAt),
      profile.isDeleted ?? false,
      profile.gender ?? null,
      profile.birthDate ?? null,
      profile.height ?? null,
      profile.weight ?? null,
      profile.additionalInfo ?? null,
      JSON.stringify(profile.friends ?? []),
      profile.version ?? 0,
      toIsoString(profile.serverUpdatedAt, profile.updatedAt),
    ],
  );
}

async function upsertWorkoutType(client: PoolClient, storageKey: string, workoutType: StorageWorkoutType) {
  await client.query(
    `
      INSERT INTO storage_workout_types (
        storage_key,
        id,
        name,
        category,
        sort_order,
        updated_at,
        is_deleted,
        version,
        server_updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::timestamptz)
      ON CONFLICT (storage_key, id)
      DO UPDATE SET
        name = EXCLUDED.name,
        category = EXCLUDED.category,
        sort_order = EXCLUDED.sort_order,
        updated_at = EXCLUDED.updated_at,
        is_deleted = EXCLUDED.is_deleted,
        version = EXCLUDED.version,
        server_updated_at = EXCLUDED.server_updated_at
    `,
    [
      storageKey,
      workoutType.id,
      workoutType.name,
      workoutType.category ?? null,
      workoutType.order ?? null,
      toIsoString(workoutType.updatedAt),
      workoutType.isDeleted ?? false,
      workoutType.version ?? 0,
      toIsoString(workoutType.serverUpdatedAt, workoutType.updatedAt),
    ],
  );
}

async function upsertWorkout(client: PoolClient, storageKey: string, workout: StorageWorkout) {
  await client.query(
    `
      INSERT INTO storage_workouts (
        storage_key,
        id,
        start_time,
        end_time,
        name,
        status,
        is_manual,
        pause_intervals_json,
        updated_at,
        is_deleted,
        version,
        server_updated_at
      )
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8::jsonb, $9::timestamptz, $10, $11, $12::timestamptz)
      ON CONFLICT (storage_key, id)
      DO UPDATE SET
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        is_manual = EXCLUDED.is_manual,
        pause_intervals_json = EXCLUDED.pause_intervals_json,
        updated_at = EXCLUDED.updated_at,
        is_deleted = EXCLUDED.is_deleted,
        version = EXCLUDED.version,
        server_updated_at = EXCLUDED.server_updated_at
    `,
    [
      storageKey,
      workout.id,
      toIsoString(workout.startTime),
      workout.endTime ? toIsoString(workout.endTime) : null,
      workout.name ?? null,
      workout.status,
      workout.isManual,
      JSON.stringify(workout.pauseIntervals ?? []),
      toIsoString(workout.updatedAt),
      workout.isDeleted ?? false,
      workout.version ?? 0,
      toIsoString(workout.serverUpdatedAt, workout.updatedAt),
    ],
  );
}

async function upsertLog(client: PoolClient, storageKey: string, log: StorageLogEntry) {
  await client.query(
    `
      INSERT INTO storage_logs (
        storage_key,
        id,
        workout_type_id,
        workout_id,
        reps,
        weight,
        duration,
        duration_seconds,
        logged_at,
        updated_at,
        is_deleted,
        version,
        server_updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, $12, $13::timestamptz)
      ON CONFLICT (storage_key, id)
      DO UPDATE SET
        workout_type_id = EXCLUDED.workout_type_id,
        workout_id = EXCLUDED.workout_id,
        reps = EXCLUDED.reps,
        weight = EXCLUDED.weight,
        duration = EXCLUDED.duration,
        duration_seconds = EXCLUDED.duration_seconds,
        logged_at = EXCLUDED.logged_at,
        updated_at = EXCLUDED.updated_at,
        is_deleted = EXCLUDED.is_deleted,
        version = EXCLUDED.version,
        server_updated_at = EXCLUDED.server_updated_at
    `,
    [
      storageKey,
      log.id,
      log.workoutTypeId,
      log.workoutId ?? null,
      log.reps ?? null,
      log.weight ?? null,
      log.duration ?? null,
      log.durationSeconds ?? null,
      toIsoString(log.date),
      toIsoString(log.updatedAt),
      log.isDeleted ?? false,
      log.version ?? 0,
      toIsoString(log.serverUpdatedAt, log.updatedAt),
    ],
  );
}

function buildPublicProfile(
  profile: StorageProfile,
  workoutTypes: StorageWorkoutType[],
  logs: StorageLogEntry[],
  fallbackIdentifier: string,
): PublicProfileData {
  const visibleWorkoutTypes = workoutTypes.filter((entry) => !entry.isDeleted);
  const visibleWorkoutTypeIds = new Set(visibleWorkoutTypes.map((entry) => entry.id));
  const visibleLogs = logs.filter((entry) => !entry.isDeleted && visibleWorkoutTypeIds.has(entry.workoutTypeId));

  const totalVolume = visibleLogs.reduce((total, entry) => total + ((entry.weight ?? 0) * (entry.reps ?? 0)), 0);
  const favoriteExerciseId = visibleLogs.reduce<Map<string, number>>((counts, entry) => {
    counts.set(entry.workoutTypeId, (counts.get(entry.workoutTypeId) ?? 0) + 1);
    return counts;
  }, new Map());

  const favoriteExercise = [...favoriteExerciseId.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0];

  const favoriteExerciseName = favoriteExercise
    ? visibleWorkoutTypes.find((entry) => entry.id === favoriteExercise)?.name
    : undefined;

  const recentActivityMap = visibleLogs.reduce<Map<string, number>>((activity, entry) => {
    const day = entry.date.slice(0, 10);
    activity.set(day, (activity.get(day) ?? 0) + 1);
    return activity;
  }, new Map());

  const recentActivity = [...recentActivityMap.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(-14)
    .map(([date, exerciseCount]) => ({ date, exerciseCount }));

  return {
    displayName: profile.displayName || profile.username || profile.telegramUsername || fallbackIdentifier,
    identifier: profile.username || profile.telegramUsername || fallbackIdentifier,
    photoUrl: profile.photoUrl,
    stats: {
      totalWorkouts: recentActivity.reduce((total, entry) => total + entry.exerciseCount, 0),
      totalVolume,
      favoriteExercise: favoriteExerciseName,
      lastWorkoutDate: visibleLogs.length > 0
        ? [...visibleLogs].sort((left, right) => left.date.localeCompare(right.date)).at(-1)?.date
        : undefined,
    },
    recentActivity,
    ...(profile.showFullHistory
      ? {
          logs: visibleLogs,
          workoutTypes: visibleWorkoutTypes,
        }
      : {}),
  };
}

async function refreshPublicAliases(client: PoolClient, storageKey: string, profile: StorageProfile | undefined) {
  const desired = new Map<string, { alias: string; type: string }>();
  desired.set(`id_${storageKey}`.toLowerCase(), { alias: `id_${storageKey}`, type: 'storage_id' });

  if (profile && !profile.isDeleted) {
    if (profile.username) {
      const alias = normalizeAlias(profile.username);
      desired.set(alias, { alias: profile.username, type: 'canonical_username' });
    }

    if (profile.telegramUsername) {
      const alias = normalizeAlias(profile.telegramUsername);
      desired.set(alias, { alias: profile.telegramUsername, type: 'telegram_username' });
    }
  }

  await client.query('DELETE FROM public_profile_aliases WHERE storage_key = $1', [storageKey]);

  for (const entry of desired.values()) {
    await client.query(
      `
        INSERT INTO public_profile_aliases (alias_lower, alias, storage_key, type, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (alias_lower)
        DO UPDATE SET alias = EXCLUDED.alias, storage_key = EXCLUDED.storage_key, type = EXCLUDED.type, updated_at = NOW()
      `,
      [normalizeAlias(entry.alias), entry.alias, storageKey, entry.type],
    );
  }
}

async function invalidatePublicProfileCache(client: PoolClient, storageKey: string) {
  await client.query('DELETE FROM public_profile_cache WHERE storage_key = $1', [storageKey]);
}

function mergeConflictEntity<T extends StorageWorkoutType | StorageWorkout | StorageLogEntry>(
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

function listSyncAcknowledgements(changes: StorageSyncRequest['changes']): SyncAcknowledgement[] {
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

function hasOutgoingSyncChanges(changes: StorageSyncRequest['changes']): boolean {
  return Boolean(
    changes.profile
    || changes.workoutTypes?.length
    || changes.logs?.length
    || changes.workouts?.length,
  );
}

async function readPagedSyncChanges(
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

export interface StoragePauseInterval {
  start: string;
  end?: string;
}

export interface StorageWorkoutType {
  id: string;
  name: string;
  category?: 'strength' | 'time';
  order?: number;
  updatedAt?: string;
  isDeleted?: boolean;
  version?: number;
  serverUpdatedAt?: string;
}

export interface StorageLogEntry {
  id: string;
  workoutTypeId: string;
  workoutId?: string;
  reps?: number;
  weight?: number;
  duration?: number;
  durationSeconds?: number;
  date: string;
  updatedAt?: string;
  isDeleted?: boolean;
  version?: number;
  serverUpdatedAt?: string;
}

export interface StorageWorkout {
  id: string;
  startTime: string;
  endTime?: string;
  name?: string;
  status: string;
  isManual: boolean;
  pauseIntervals: StoragePauseInterval[];
  updatedAt?: string;
  isDeleted?: boolean;
  version?: number;
  serverUpdatedAt?: string;
}

export interface StorageFriend {
  identifier: string;
  displayName: string;
  photoUrl?: string;
  addedAt: string;
}

export interface StorageProfile {
  id: string;
  isPublic: boolean;
  showFullHistory?: boolean;
  displayName?: string;
  username?: string;
  telegramUsername?: string;
  telegramUserId?: number;
  photoUrl?: string;
  createdAt: string;
  updatedAt?: string;
  isDeleted?: boolean;
  gender?: 'male' | 'female' | 'other';
  birthDate?: string;
  height?: number;
  weight?: number;
  additionalInfo?: string;
  friends?: StorageFriend[];
  version?: number;
  serverUpdatedAt?: string;
}

export interface StorageData {
  revision?: number;
  workoutTypes?: StorageWorkoutType[];
  logs?: StorageLogEntry[];
  workouts?: StorageWorkout[];
  profile?: StorageProfile;
  [key: string]: unknown;
}

export type SyncEntityType = 'workoutTypes' | 'logs' | 'workouts' | 'profile';

export interface SyncConflict {
  entityType: SyncEntityType;
  entityId: string;
  reason: 'stale-version';
  serverVersion: number;
}

export interface SyncAcknowledgement {
  entityType: SyncEntityType;
  entityId: string;
}

export interface StorageSyncRequest {
  cursor: number;
  protocolVersion?: number;
  limit?: number;
  batchId?: string;
  changes: {
    workoutTypes?: StorageWorkoutType[];
    logs?: StorageLogEntry[];
    workouts?: StorageWorkout[];
    profile?: StorageProfile | null;
  };
}

export interface StorageSyncResponse {
  cursor: number;
  changes: {
    workoutTypes: StorageWorkoutType[];
    logs: StorageLogEntry[];
    workouts: StorageWorkout[];
    profile: StorageProfile | null;
  };
  conflicts: SyncConflict[];
  acknowledged: SyncAcknowledgement[];
  protocolVersion: number;
  hasMore: boolean;
}

export interface PublicProfileData {
  displayName: string;
  identifier: string;
  photoUrl?: string;
  stats: {
    totalWorkouts: number;
    totalVolume: number;
    favoriteExercise?: string;
    lastWorkoutDate?: string;
  };
  recentActivity: { date: string; exerciseCount: number }[];
  logs?: Pick<StorageLogEntry, 'id' | 'workoutTypeId' | 'workoutId' | 'reps' | 'weight' | 'duration' | 'durationSeconds' | 'date'>[];
  workoutTypes?: Pick<StorageWorkoutType, 'id' | 'name' | 'category'>[];
}

export interface AIStorageContext {
  profile?: StorageProfile;
  logs: StorageLogEntry[];
  workouts: StorageWorkout[];
  workoutTypes: StorageWorkoutType[];
}

export interface StorageRepository {
  readSnapshot(storageKey: string | number): Promise<StorageData>;
  replaceSnapshot(storageKey: string | number, data: StorageData): Promise<void>;
  sync(storageKey: string | number, request: StorageSyncRequest, authContext: AuthenticatedRequestContext): Promise<StorageSyncResponse>;
  updateProfileFromAuth(storageKey: string | number, data: {
    username?: string | null;
    name?: string | null;
    image?: string | null;
    telegramUser?: AuthenticatedRequestContext['telegramUser'];
  }): Promise<void>;
  readAiContext(storageKey: string | number): Promise<AIStorageContext>;
  findPublicProfileByIdentifier(identifier: string): Promise<PublicProfileData | null>;
  getPublicProfileByStorageKey(storageKey: string | number, fallbackIdentifier?: string): Promise<PublicProfileData | null>;
}

class PostgresStorageRepository implements StorageRepository {
  async readSnapshot(storageKeyInput: string | number): Promise<StorageData> {
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

  async replaceSnapshot(storageKeyInput: string | number, data: StorageData): Promise<void> {
    await ensureDatabaseReady();
    const storageKey = sanitizeStorageKey(storageKeyInput);
    const prepared = prepareImportedSnapshot(data);
    const client = await getDatabasePool().connect();

    try {
      await client.query('BEGIN');
      await ensureStorageRoot(client, storageKey);

      await client.query('DELETE FROM storage_profiles WHERE storage_key = $1', [storageKey]);
      await client.query('DELETE FROM storage_workout_types WHERE storage_key = $1', [storageKey]);
      await client.query('DELETE FROM storage_workouts WHERE storage_key = $1', [storageKey]);
      await client.query('DELETE FROM storage_logs WHERE storage_key = $1', [storageKey]);

      if (prepared.profile) {
        await upsertProfile(client, storageKey, prepared.profile.item);
      }

      for (const entry of prepared.workoutTypes) {
        await upsertWorkoutType(client, storageKey, entry.item);
      }

      for (const entry of prepared.workouts) {
        await upsertWorkout(client, storageKey, entry.item);
      }

      for (const entry of prepared.logs) {
        await upsertLog(client, storageKey, entry.item);
      }

      await updateStorageRootRevision(client, storageKey, prepared.revision);
      await refreshPublicAliases(client, storageKey, prepared.profile?.item);
      await invalidatePublicProfileCache(client, storageKey);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async sync(
    storageKeyInput: string | number,
    request: StorageSyncRequest,
    authContext: AuthenticatedRequestContext,
  ): Promise<StorageSyncResponse> {
    await ensureDatabaseReady();
    validateSyncRequest(request);
    const storageKey = sanitizeStorageKey(storageKeyInput);
    const client = await getDatabasePool().connect();

    try {
      await client.query('BEGIN');
      let revision = await ensureStorageRoot(client, storageKey);
      if (request.batchId) {
        const receiptResult = await client.query<SyncReceiptRow>(
          `
            SELECT response_payload
            FROM storage_sync_receipts
            WHERE storage_key = $1 AND batch_id = $2
            LIMIT 1
          `,
          [storageKey, request.batchId],
        );
        if (receiptResult.rows[0]) {
          const storedResponse = parseSyncReceiptPayload(receiptResult.rows[0].response_payload);
          await client.query('COMMIT');
          return storedResponse;
        }
      }

      const conflicts: SyncConflict[] = [];
      let profileChanged = false;
      let workoutTypesChanged = false;
      let workoutsChanged = false;
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

      for (const incoming of request.changes.workoutTypes ?? []) {
        const existing = existingWorkoutTypes.get(incoming.id);
        const existingVersion = existing ? toNumber(existing.version) : 0;

        if (existing && (incoming.version ?? 0) !== existingVersion) {
          conflicts.push({
            entityType: 'workoutTypes',
            entityId: incoming.id,
            reason: 'stale-version',
            serverVersion: existingVersion,
          });
          authoritativeWorkoutTypes = mergeConflictEntity(authoritativeWorkoutTypes, mapWorkoutTypeRow(existing));
          continue;
        }

        if (!existing && incoming.isDeleted) {
          continue;
        }

        revision += 1;
        const normalized: StorageWorkoutType = {
          ...incoming,
          updatedAt: normalizeTimestamp(incoming.updatedAt, new Date().toISOString()),
          isDeleted: incoming.isDeleted ?? false,
          version: revision,
          serverUpdatedAt: new Date().toISOString(),
        };
        await upsertWorkoutType(client, storageKey, normalized);
        workoutTypesChanged = true;
      }

      for (const incoming of request.changes.workouts ?? []) {
        const existing = existingWorkouts.get(incoming.id);
        const existingVersion = existing ? toNumber(existing.version) : 0;

        if (existing && (incoming.version ?? 0) !== existingVersion) {
          conflicts.push({
            entityType: 'workouts',
            entityId: incoming.id,
            reason: 'stale-version',
            serverVersion: existingVersion,
          });
          authoritativeWorkouts = mergeConflictEntity(authoritativeWorkouts, mapWorkoutRow(existing));
          continue;
        }

        if (!existing && incoming.isDeleted) {
          continue;
        }

        revision += 1;
        const normalized: StorageWorkout = {
          ...incoming,
          pauseIntervals: Array.isArray(incoming.pauseIntervals) ? cloneValue(incoming.pauseIntervals) : [],
          updatedAt: normalizeTimestamp(incoming.updatedAt, incoming.startTime),
          isDeleted: incoming.isDeleted ?? false,
          version: revision,
          serverUpdatedAt: new Date().toISOString(),
        };
        await upsertWorkout(client, storageKey, normalized);
        workoutsChanged = true;
      }

      for (const incoming of request.changes.logs ?? []) {
        const existing = existingLogs.get(incoming.id);
        const existingVersion = existing ? toNumber(existing.version) : 0;

        if (existing && (incoming.version ?? 0) !== existingVersion) {
          conflicts.push({
            entityType: 'logs',
            entityId: incoming.id,
            reason: 'stale-version',
            serverVersion: existingVersion,
          });
          authoritativeLogs = mergeConflictEntity(authoritativeLogs, mapLogRow(existing));
          continue;
        }

        if (!existing && incoming.isDeleted) {
          continue;
        }

        revision += 1;
        const normalized: StorageLogEntry = {
          ...incoming,
          updatedAt: normalizeTimestamp(incoming.updatedAt, incoming.date),
          isDeleted: incoming.isDeleted ?? false,
          version: revision,
          serverUpdatedAt: new Date().toISOString(),
        };
        await upsertLog(client, storageKey, normalized);
        logsChanged = true;
      }

      if (request.changes.profile) {
        const incoming = normalizeProfileForWrite(request.changes.profile, {
          existing: existingProfile,
          authContext,
        });
        const existingVersion = existingProfile?.version ?? 0;

        if (existingProfile && (request.changes.profile.version ?? 0) !== existingVersion) {
          conflicts.push({
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

      let pulled: Pick<StorageSyncResponse, 'cursor' | 'changes' | 'hasMore'>;
      if (request.limit && !hasOutgoingSyncChanges(request.changes)) {
        pulled = await readPagedSyncChanges(client, storageKey, request.cursor, revision, request.limit);
      } else {
        const [profileResult, workoutTypeResult, workoutResult, logResult] = await Promise.all([
          client.query<StorageProfileRow>(
            'SELECT * FROM storage_profiles WHERE storage_key = $1 AND version > $2 ORDER BY version ASC LIMIT 1',
            [storageKey, request.cursor],
          ),
          client.query<StorageWorkoutTypeRow>(
            'SELECT * FROM storage_workout_types WHERE storage_key = $1 AND version > $2 ORDER BY version ASC',
            [storageKey, request.cursor],
          ),
          client.query<StorageWorkoutRow>(
            'SELECT * FROM storage_workouts WHERE storage_key = $1 AND version > $2 ORDER BY version ASC',
            [storageKey, request.cursor],
          ),
          client.query<StorageLogRow>(
            'SELECT * FROM storage_logs WHERE storage_key = $1 AND version > $2 ORDER BY version ASC',
            [storageKey, request.cursor],
          ),
        ]);
        pulled = {
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

      const response: StorageSyncResponse = {
        cursor: pulled.cursor,
        changes: pulled.changes,
        conflicts,
        acknowledged: listSyncAcknowledgements(request.changes),
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

      if (request.batchId) {
        await client.query(
          `
            INSERT INTO storage_sync_receipts (storage_key, batch_id, response_payload)
            VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (storage_key, batch_id) DO NOTHING
          `,
          [storageKey, request.batchId, JSON.stringify(response)],
        );
        await client.query(
          `
            DELETE FROM storage_sync_receipts
            WHERE storage_key = $1
              AND created_at < NOW() - INTERVAL '30 days'
          `,
          [storageKey],
        );
      }

      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateProfileFromAuth(
    storageKeyInput: string | number,
    data: {
      username?: string | null;
      name?: string | null;
      image?: string | null;
      telegramUser?: AuthenticatedRequestContext['telegramUser'];
    },
  ): Promise<void> {
    await ensureDatabaseReady();
    const storageKey = sanitizeStorageKey(storageKeyInput);
    const client = await getDatabasePool().connect();

    try {
      await client.query('BEGIN');
      let revision = await ensureStorageRoot(client, storageKey);
      const existingProfile = await readExistingProfile(client, storageKey);
      const now = new Date().toISOString();
      const profile = normalizeProfileForWrite(
        {
          ...(existingProfile ?? {
            id: STORAGE_PROFILE_ID,
            isPublic: false,
            createdAt: now,
            updatedAt: now,
          }),
          ...(data.username ? { username: data.username } : {}),
          ...(!existingProfile?.displayName && data.name ? { displayName: data.name } : {}),
          ...(data.image ? { photoUrl: data.image } : {}),
          ...(data.telegramUser
            ? {
                telegramUserId: data.telegramUser.id,
                telegramUsername: data.telegramUser.username,
                photoUrl: data.telegramUser.photo_url ?? (data.image ?? existingProfile?.photoUrl),
              }
            : {}),
        },
        {
          existing: existingProfile,
          now,
        },
      );

      revision += 1;
      profile.version = revision;
      profile.serverUpdatedAt = now;

      await upsertProfile(client, storageKey, profile);
      await updateStorageRootRevision(client, storageKey, revision);
      await refreshPublicAliases(client, storageKey, profile);
      await invalidatePublicProfileCache(client, storageKey);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async readAiContext(storageKeyInput: string | number): Promise<AIStorageContext> {
    await ensureDatabaseReady();
    const storageKey = sanitizeStorageKey(storageKeyInput);
    const pool = getDatabasePool();

    const [profileResult, workoutTypeResult, workoutResult, logResult] = await Promise.all([
      pool.query<StorageProfileRow>('SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1', [storageKey]),
      pool.query<StorageWorkoutTypeRow>(
        'SELECT * FROM storage_workout_types WHERE storage_key = $1 AND is_deleted = FALSE ORDER BY updated_at DESC, id ASC',
        [storageKey],
      ),
      pool.query<StorageWorkoutRow>(
        'SELECT * FROM storage_workouts WHERE storage_key = $1 AND is_deleted = FALSE ORDER BY start_time DESC, id ASC LIMIT 20',
        [storageKey],
      ),
      pool.query<StorageLogRow>(
        'SELECT * FROM storage_logs WHERE storage_key = $1 AND is_deleted = FALSE ORDER BY logged_at DESC, id ASC LIMIT $2',
        [storageKey, config.AI_MAX_RECENT_LOGS],
      ),
    ]);

    return {
      profile: mapProfileRow(profileResult.rows[0]),
      workoutTypes: workoutTypeResult.rows.map(mapWorkoutTypeRow),
      workouts: workoutResult.rows.map(mapWorkoutRow),
      logs: logResult.rows.map(mapLogRow).reverse(),
    };
  }

  async findPublicProfileByIdentifier(identifier: string): Promise<PublicProfileData | null> {
    await ensureDatabaseReady();
    const normalizedIdentifier = normalizeAlias(identifier);
    if (!normalizedIdentifier) {
      return null;
    }

    const result = await getDatabasePool().query<AliasRow>(
      'SELECT storage_key FROM public_profile_aliases WHERE alias_lower = $1 LIMIT 1',
      [normalizedIdentifier],
    );
    const storageKey = result.rows[0]?.storage_key;
    if (!storageKey) {
      return null;
    }

    return this.getPublicProfileByStorageKey(storageKey, identifier);
  }

  async getPublicProfileByStorageKey(
    storageKeyInput: string | number,
    fallbackIdentifier?: string,
  ): Promise<PublicProfileData | null> {
    await ensureDatabaseReady();
    const storageKey = sanitizeStorageKey(storageKeyInput);
    const pool = getDatabasePool();

    const [rootResult, profileResult] = await Promise.all([
      pool.query<RootRow>('SELECT server_revision FROM storage_roots WHERE storage_key = $1 LIMIT 1', [storageKey]),
      pool.query<StorageProfileRow>('SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1', [storageKey]),
    ]);

    const revision = toNumber(rootResult.rows[0]?.server_revision);
    const profile = mapProfileRow(profileResult.rows[0]);
    if (!profile || profile.isDeleted || !profile.isPublic) {
      return null;
    }

    const cacheResult = await pool.query<CacheRow>(
      'SELECT source_revision, payload FROM public_profile_cache WHERE storage_key = $1 LIMIT 1',
      [storageKey],
    );
    const cached = cacheResult.rows[0];
    if (cached && toNumber(cached.source_revision) === revision) {
      return cached.payload;
    }

    const [workoutTypeResult, logResult] = await Promise.all([
      pool.query<StorageWorkoutTypeRow>(
        'SELECT * FROM storage_workout_types WHERE storage_key = $1 ORDER BY updated_at DESC, id ASC',
        [storageKey],
      ),
      pool.query<StorageLogRow>(
        'SELECT * FROM storage_logs WHERE storage_key = $1 ORDER BY logged_at DESC, id ASC',
        [storageKey],
      ),
    ]);

    const payload = buildPublicProfile(
      profile,
      workoutTypeResult.rows.map(mapWorkoutTypeRow),
      logResult.rows.map(mapLogRow),
      fallbackIdentifier ?? `id_${storageKey}`,
    );

    await pool.query(
      `
        INSERT INTO public_profile_cache (storage_key, source_revision, payload, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (storage_key)
        DO UPDATE SET source_revision = EXCLUDED.source_revision, payload = EXCLUDED.payload, updated_at = NOW()
      `,
      [storageKey, revision, JSON.stringify(payload)],
    );

    return payload;
  }
}

export const defaultStorageRepository: StorageRepository = new PostgresStorageRepository();

export class Storage {
  static async read(storageKey: string | number): Promise<StorageData> {
    return defaultStorageRepository.readSnapshot(storageKey);
  }

  static async write(storageKey: string | number, data: StorageData): Promise<void> {
    return defaultStorageRepository.replaceSnapshot(storageKey, data);
  }

  static async getPublicProfile(identifier: string): Promise<PublicProfileData | null> {
    return defaultStorageRepository.findPublicProfileByIdentifier(identifier);
  }

  static async getPublicProfileByStorageKey(storageKey: string | number, fallbackIdentifier?: string): Promise<PublicProfileData | null> {
    return defaultStorageRepository.getPublicProfileByStorageKey(storageKey, fallbackIdentifier);
  }
}

export { prepareImportedSnapshot };
