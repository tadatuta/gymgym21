import type { AuthenticatedRequestContext } from '../auth.js';
import type { StorageProfile } from './types.js';
import { STORAGE_PROFILE_ID, cloneValue, normalizeTimestamp } from './values.js';

export function normalizeProfileForWrite(
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

  // Sync identity comes exclusively from authenticated server state, including absence.
  if (options.authContext) {
    normalized.username = options.authContext.authUser?.username ?? undefined;
    normalized.telegramUserId = options.authContext.telegramUser?.id;
    normalized.telegramUsername = options.authContext.telegramUser?.username;
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
