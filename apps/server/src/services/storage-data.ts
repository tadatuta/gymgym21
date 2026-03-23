import type { AuthenticatedRequestContext } from '../auth.js';
import { HttpError } from '../http/errors.js';
import type { StorageData } from '../storage.js';

const MAX_NAME_LENGTH = 100;
const MAX_LOGS = 10000;
const MAX_DISPLAY_NAME = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureProfileMetadata(profile: NonNullable<StorageData['profile']>, data: StorageData) {
  const now = new Date().toISOString();
  profile.id = profile.id || 'me';
  profile.createdAt = profile.createdAt || now;
  profile.updatedAt = now;
  profile.friends = profile.friends ?? data.profile?.friends ?? [];
}

export function prepareStorageDataForWrite(input: unknown, authContext: AuthenticatedRequestContext): StorageData {
  if (!isRecord(input)) {
    throw new HttpError(400, 'Invalid JSON');
  }

  const data = input as StorageData;

  if (data.workoutTypes !== undefined && !Array.isArray(data.workoutTypes)) {
    throw new HttpError(400, 'workoutTypes must be an array');
  }

  if (data.logs !== undefined && !Array.isArray(data.logs)) {
    throw new HttpError(400, 'logs must be an array');
  }

  if (data.workouts !== undefined && !Array.isArray(data.workouts)) {
    throw new HttpError(400, 'workouts must be an array');
  }

  if (data.profile !== undefined && !isRecord(data.profile)) {
    throw new HttpError(400, 'profile must be an object');
  }

  if (data.workoutTypes) {
    for (const workoutType of data.workoutTypes) {
      if (workoutType.name && workoutType.name.length > MAX_NAME_LENGTH) {
        throw new HttpError(400, 'Workout type name too long');
      }
    }
  }

  if (data.logs && data.logs.length > MAX_LOGS) {
    throw new HttpError(400, 'Too many log entries');
  }

  if (data.profile?.displayName && data.profile.displayName.length > MAX_DISPLAY_NAME) {
    throw new HttpError(400, 'Display name too long');
  }

  if (data.profile) {
    ensureProfileMetadata(data.profile, data);

    if (authContext.authUser?.username) {
      data.profile.username = authContext.authUser.username;
    }

    if (authContext.authUser?.image && !data.profile.photoUrl) {
      data.profile.photoUrl = authContext.authUser.image;
    }

    if (authContext.telegramUser) {
      data.profile.telegramUserId = authContext.telegramUser.id;
      if (authContext.telegramUser.username) {
        data.profile.telegramUsername = authContext.telegramUser.username;
      }
      if (authContext.telegramUser.photo_url) {
        data.profile.photoUrl = authContext.telegramUser.photo_url;
      }
    }
  }

  return data;
}
