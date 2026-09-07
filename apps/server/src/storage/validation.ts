import { HttpError } from '../http/errors.js';
import type { StorageData, StorageSyncRequest } from './types.js';
import { MAX_NAME_LENGTH, MAX_DISPLAY_NAME_LENGTH, MAX_LOG_COUNT, isRecord } from './values.js';

export function validateStorageDataShape(data: StorageData, maxLogs = MAX_LOG_COUNT) {
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

  if ((data.logs?.length ?? 0) > maxLogs) {
    throw new HttpError(400, 'Too many log entries');
  }

  if (data.profile?.displayName && data.profile.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new HttpError(400, 'Display name too long');
  }
}

export function validateSyncRequest(request: StorageSyncRequest, backup = false) {
  if (!Number.isInteger(request.cursor) || request.cursor < 0) {
    throw new HttpError(400, 'cursor must be a non-negative integer');
  }
  if (request.batchId && !/^[a-zA-Z0-9_-]{1,100}$/.test(request.batchId)) {
    throw new HttpError(400, 'batchId is invalid');
  }

  if (!backup) {
    const count = (request.changes.workoutTypes?.length ?? 0) + (request.changes.logs?.length ?? 0)
      + (request.changes.workouts?.length ?? 0) + (request.changes.profile ? 1 : 0);
    if (count > 500) throw new HttpError(413, 'Sync push exceeds 500 entities; split into batches', { code: 'sync_batch_too_large' });
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 512 * 1024) {
      throw new HttpError(413, 'Sync push exceeds 512 KiB; split into batches', { code: 'sync_batch_too_large' });
    }
    if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 2000)) {
      throw new HttpError(400, 'limit must be an integer between 1 and 2000');
    }
  }

  const dataForValidation: StorageData = {
    workoutTypes: request.changes.workoutTypes,
    logs: request.changes.logs,
    workouts: request.changes.workouts,
    ...(request.changes.profile ? { profile: request.changes.profile } : {}),
  };

  validateStorageDataShape(dataForValidation, backup ? 100000 : MAX_LOG_COUNT);
}
