import type { PoolClient } from 'pg';
import type { StorageWorkoutType, StorageLogEntry, StorageWorkout, StorageProfile } from './types.js';
import type { RevisionRow } from './rows.js';
import { toNumber, toIsoString } from './values.js';

export async function ensureStorageRoot(client: PoolClient, storageKey: string): Promise<number> {
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

export async function updateStorageRootRevision(client: PoolClient, storageKey: string, revision: number) {
  await client.query(
    `
      UPDATE storage_roots
      SET server_revision = $2, updated_at = NOW()
      WHERE storage_key = $1
    `,
    [storageKey, revision],
  );
}

export async function upsertProfile(client: PoolClient, storageKey: string, profile: StorageProfile) {
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
        server_updated_at,
        time_zone
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10::timestamptz, $11::timestamptz, $12, $13, $14::date, $15, $16, $17, $18::jsonb, $19, $20::timestamptz, $21
      )
      ON CONFLICT (storage_key)
      DO UPDATE SET
        profile_id = EXCLUDED.profile_id,
        time_zone = EXCLUDED.time_zone,
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
      profile.timeZone ?? null,
    ],
  );
}

export async function upsertWorkoutType(client: PoolClient, storageKey: string, workoutType: StorageWorkoutType) {
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

export async function upsertWorkout(client: PoolClient, storageKey: string, workout: StorageWorkout) {
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

export async function upsertLog(client: PoolClient, storageKey: string, log: StorageLogEntry) {
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
