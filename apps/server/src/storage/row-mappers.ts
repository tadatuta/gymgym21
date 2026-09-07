import type { StorageWorkoutType, StorageLogEntry, StorageWorkout, StorageProfile } from './types.js';
import type { StorageProfileRow, StorageWorkoutTypeRow, StorageWorkoutRow, StorageLogRow } from './rows.js';
import { cloneValue, toNumber, toIsoString } from './values.js';

export function mapProfileRow(row: StorageProfileRow | undefined): StorageProfile | undefined {
  if (!row) {
    return undefined;
  }

  return {
    id: row.profile_id,
    timeZone: row.time_zone ?? undefined,
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

export function mapWorkoutTypeRow(row: StorageWorkoutTypeRow): StorageWorkoutType {
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

export function mapWorkoutRow(row: StorageWorkoutRow): StorageWorkout {
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

export function mapLogRow(row: StorageLogRow): StorageLogEntry {
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
