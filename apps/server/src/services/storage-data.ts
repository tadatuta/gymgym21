import type { AuthenticatedRequestContext } from '../auth.js';
import { HttpError } from '../http/errors.js';
import type {
  StorageData,
  StorageLogEntry,
  StorageProfile,
  StorageSyncRequest,
  StorageSyncResponse,
  StorageWorkout,
  StorageWorkoutType,
  SyncConflict,
  SyncEntityType,
} from '../storage.js';

const MAX_NAME_LENGTH = 100;
const MAX_LOGS = 10000;
const MAX_DISPLAY_NAME = 100;
const ARRAY_COLLECTIONS = ['workoutTypes', 'logs', 'workouts'] as const;

type ArrayCollection = (typeof ARRAY_COLLECTIONS)[number];
type SyncArrayItem = StorageWorkoutType | StorageLogEntry | StorageWorkout;
type SyncEntity = SyncArrayItem | StorageProfile;
type NormalizedStorageData = Required<Pick<StorageData, ArrayCollection>> & {
  revision: number;
  profile?: StorageProfile;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureTimestamp(candidate: string | undefined, fallback: string): string {
  if (candidate) {
    return candidate;
  }

  return fallback;
}

function normalizeSyncEntity<T extends SyncEntity>(item: T, fallbackTimestamp: string, defaultVersion?: number): T {
  const normalized = { ...item } as T;
  normalized.updatedAt = ensureTimestamp(normalized.updatedAt, fallbackTimestamp);

  if (defaultVersion !== undefined && (!normalized.version || normalized.version < 1)) {
    normalized.version = defaultVersion;
  }

  normalized.serverUpdatedAt = ensureTimestamp(normalized.serverUpdatedAt, normalized.updatedAt);
  return normalized;
}

function normalizeStoredData(input: StorageData): { data: NormalizedStorageData; changed: boolean } {
  const source = cloneValue(input ?? {});
  let revision = Number.isInteger(source.revision) && (source.revision ?? 0) >= 0 ? Number(source.revision) : 0;
  let changed = revision !== (source.revision ?? 0);

  const normalized: NormalizedStorageData = {
    revision,
    workoutTypes: Array.isArray(source.workoutTypes) ? source.workoutTypes : [],
    logs: Array.isArray(source.logs) ? source.logs : [],
    workouts: Array.isArray(source.workouts) ? source.workouts : [],
    ...(source.profile && isRecord(source.profile) ? { profile: source.profile } : {}),
  };

  normalized.workoutTypes = normalized.workoutTypes.map((item) => {
    const fallbackTimestamp = ensureTimestamp(item.updatedAt, new Date().toISOString());
    if (!item.version || item.version < 1) {
      revision += 1;
      changed = true;
      return normalizeSyncEntity(item, fallbackTimestamp, revision);
    }

    revision = Math.max(revision, item.version);
    const normalizedItem = normalizeSyncEntity(item, fallbackTimestamp);
    if (normalizedItem.serverUpdatedAt !== item.serverUpdatedAt || normalizedItem.updatedAt !== item.updatedAt) {
      changed = true;
    }
    return normalizedItem;
  });

  normalized.logs = normalized.logs.map((item) => {
    const fallbackTimestamp = ensureTimestamp(item.updatedAt, new Date().toISOString());
    if (!item.version || item.version < 1) {
      revision += 1;
      changed = true;
      return normalizeSyncEntity(item, fallbackTimestamp, revision);
    }

    revision = Math.max(revision, item.version);
    const normalizedItem = normalizeSyncEntity(item, fallbackTimestamp);
    if (normalizedItem.serverUpdatedAt !== item.serverUpdatedAt || normalizedItem.updatedAt !== item.updatedAt) {
      changed = true;
    }
    return normalizedItem;
  });

  normalized.workouts = normalized.workouts.map((item) => {
    const fallbackTimestamp = ensureTimestamp(item.updatedAt, new Date().toISOString());
    if (!item.version || item.version < 1) {
      revision += 1;
      changed = true;
      return normalizeSyncEntity(item, fallbackTimestamp, revision);
    }

    revision = Math.max(revision, item.version);
    const normalizedItem = normalizeSyncEntity(item, fallbackTimestamp);
    if (normalizedItem.serverUpdatedAt !== item.serverUpdatedAt || normalizedItem.updatedAt !== item.updatedAt) {
      changed = true;
    }
    return normalizedItem;
  });

  if (normalized.profile) {
    const fallbackTimestamp = ensureTimestamp(
      normalized.profile.updatedAt,
      normalized.profile.createdAt || new Date().toISOString(),
    );

    if (!normalized.profile.version || normalized.profile.version < 1) {
      revision += 1;
      normalized.profile = normalizeSyncEntity(normalized.profile, fallbackTimestamp, revision);
      changed = true;
    } else {
      revision = Math.max(revision, normalized.profile.version);
      const nextProfile = normalizeSyncEntity(normalized.profile, fallbackTimestamp);
      if (
        nextProfile.serverUpdatedAt !== normalized.profile.serverUpdatedAt
        || nextProfile.updatedAt !== normalized.profile.updatedAt
      ) {
        changed = true;
      }
      normalized.profile = nextProfile;
    }
  }

  normalized.revision = revision;
  if (source.revision !== revision) {
    changed = true;
  }

  return { data: normalized, changed };
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
}

function applyAuthMetadata(profile: StorageProfile, authContext: AuthenticatedRequestContext, fallbackProfile?: StorageProfile) {
  const now = new Date().toISOString();
  profile.id = profile.id || fallbackProfile?.id || 'me';
  profile.createdAt = profile.createdAt || fallbackProfile?.createdAt || now;
  profile.updatedAt = now;
  profile.friends = profile.friends ?? fallbackProfile?.friends ?? [];

  if (authContext.authUser?.username) {
    profile.username = authContext.authUser.username;
  }

  if (authContext.authUser?.image && !profile.photoUrl) {
    profile.photoUrl = authContext.authUser.image;
  }

  if (authContext.telegramUser) {
    profile.telegramUserId = authContext.telegramUser.id;
    if (authContext.telegramUser.username) {
      profile.telegramUsername = authContext.telegramUser.username;
    }
    if (authContext.telegramUser.photo_url) {
      profile.photoUrl = authContext.telegramUser.photo_url;
    }
  }
}

function buildFullSnapshotForWrite(input: StorageData, authContext: AuthenticatedRequestContext, current: StorageData): StorageData {
  const data = cloneValue(input);
  validateStorageDataShape(data);

  if (data.profile) {
    applyAuthMetadata(data.profile, authContext, current.profile);
  }

  const { data: normalizedCurrent } = normalizeStoredData(current);
  let revision = normalizedCurrent.revision;
  const now = new Date().toISOString();

  const normalized: StorageData = {
    revision,
    workoutTypes: [],
    logs: [],
    workouts: [],
  };

  normalized.workoutTypes = (data.workoutTypes ?? []).map((item) => {
    revision += 1;
    return normalizeSyncEntity(item, ensureTimestamp(item.updatedAt, now), revision);
  });

  normalized.logs = (data.logs ?? []).map((item) => {
    revision += 1;
    return normalizeSyncEntity(item, ensureTimestamp(item.updatedAt, now), revision);
  });

  normalized.workouts = (data.workouts ?? []).map((item) => {
    revision += 1;
    return normalizeSyncEntity(item, ensureTimestamp(item.updatedAt, now), revision);
  });

  if (data.profile) {
    revision += 1;
    normalized.profile = normalizeSyncEntity(data.profile, ensureTimestamp(data.profile.updatedAt, now), revision);
  }

  normalized.revision = revision;
  return normalized;
}

function toStoredMap<T extends SyncArrayItem>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function shouldAcceptIncoming(existing: SyncEntity | undefined, incoming: SyncEntity): boolean {
  if (!existing) {
    return true;
  }

  const incomingVersion = incoming.version ?? 0;
  const existingVersion = existing.version ?? 0;

  if (incomingVersion === existingVersion) {
    return true;
  }

  if (incomingVersion === 0 && existingVersion === 0) {
    const incomingUpdatedAt = new Date(incoming.updatedAt ?? 0).getTime();
    const existingUpdatedAt = new Date(existing.updatedAt ?? 0).getTime();

    if (incomingUpdatedAt !== existingUpdatedAt) {
      return incomingUpdatedAt >= existingUpdatedAt;
    }

    return incoming.id >= existing.id;
  }

  return false;
}

function selectChangedSince<T extends SyncArrayItem>(items: T[], baseRevision: number): T[] | undefined {
  const changed = items.filter((item) => (item.version ?? 0) > baseRevision);
  return changed.length > 0 ? changed : undefined;
}

function selectProfileChangedSince(profile: StorageProfile | undefined, baseRevision: number): StorageProfile | undefined {
  if (!profile) {
    return undefined;
  }

  return (profile.version ?? 0) > baseRevision ? profile : undefined;
}

function mergeArrayCollection<T extends SyncArrayItem>(
  entityType: Exclude<SyncEntityType, 'profile'>,
  currentItems: T[],
  incomingItems: T[] | undefined,
  state: { revision: number },
  conflicts: SyncConflict[],
): T[] {
  if (!incomingItems?.length) {
    return currentItems;
  }

  const now = new Date().toISOString();
  const nextItems = toStoredMap(currentItems);

  for (const incomingItem of incomingItems) {
    const existing = nextItems.get(incomingItem.id);
    const normalizedIncoming = normalizeSyncEntity(incomingItem, ensureTimestamp(incomingItem.updatedAt, now));

    if (!shouldAcceptIncoming(existing, normalizedIncoming)) {
      conflicts.push({
        entityType,
        entityId: incomingItem.id,
        reason: 'stale-version',
        serverVersion: existing?.version ?? 0,
      });
      continue;
    }

    state.revision += 1;
    nextItems.set(incomingItem.id, {
      ...normalizedIncoming,
      version: state.revision,
      serverUpdatedAt: now,
    } as T);
  }

  return [...nextItems.values()];
}

function mergeProfile(
  currentProfile: StorageProfile | undefined,
  incomingProfile: StorageProfile | undefined,
  authContext: AuthenticatedRequestContext,
  state: { revision: number },
  conflicts: SyncConflict[],
): StorageProfile | undefined {
  if (!incomingProfile) {
    return currentProfile;
  }

  const now = new Date().toISOString();
  const normalizedIncoming = normalizeSyncEntity(
    incomingProfile,
    ensureTimestamp(incomingProfile.updatedAt, currentProfile?.updatedAt || currentProfile?.createdAt || now),
  );

  applyAuthMetadata(normalizedIncoming, authContext, currentProfile);

  if (!shouldAcceptIncoming(currentProfile, normalizedIncoming)) {
    conflicts.push({
      entityType: 'profile',
      entityId: normalizedIncoming.id,
      reason: 'stale-version',
      serverVersion: currentProfile?.version ?? 0,
    });
    return currentProfile;
  }

  state.revision += 1;
  return {
    ...normalizedIncoming,
    version: state.revision,
    serverUpdatedAt: now,
  };
}

export function prepareStorageDataForWrite(
  input: unknown,
  authContext: AuthenticatedRequestContext,
  current: StorageData = {},
): StorageData {
  if (!isRecord(input)) {
    throw new HttpError(400, 'Invalid JSON');
  }

  return buildFullSnapshotForWrite(input as StorageData, authContext, current);
}

export function syncStorageData(
  current: StorageData,
  request: StorageSyncRequest,
  authContext: AuthenticatedRequestContext,
): { data: StorageData; response: StorageSyncResponse; changed: boolean } {
  validateStorageDataShape(request.changes);

  if (!Number.isInteger(request.baseRevision) || request.baseRevision < 0) {
    throw new HttpError(400, 'baseRevision must be a non-negative integer');
  }

  const { data: normalizedCurrent, changed: normalizedChanged } = normalizeStoredData(current);
  const state = { revision: normalizedCurrent.revision };
  const conflicts: SyncConflict[] = [];

  const mergedWorkoutTypes = mergeArrayCollection(
    'workoutTypes',
    normalizedCurrent.workoutTypes,
    request.changes.workoutTypes,
    state,
    conflicts,
  );

  const mergedLogs = mergeArrayCollection('logs', normalizedCurrent.logs, request.changes.logs, state, conflicts);
  const mergedWorkouts = mergeArrayCollection(
    'workouts',
    normalizedCurrent.workouts,
    request.changes.workouts,
    state,
    conflicts,
  );

  const mergedProfile = mergeProfile(normalizedCurrent.profile, request.changes.profile, authContext, state, conflicts);

  const nextData: StorageData = {
    revision: state.revision,
    workoutTypes: mergedWorkoutTypes,
    logs: mergedLogs,
    workouts: mergedWorkouts,
    ...(mergedProfile ? { profile: mergedProfile } : {}),
  };

  const response: StorageSyncResponse = {
    revision: state.revision,
    changes: {
      ...(selectChangedSince(mergedWorkoutTypes, request.baseRevision) ? { workoutTypes: selectChangedSince(mergedWorkoutTypes, request.baseRevision) } : {}),
      ...(selectChangedSince(mergedLogs, request.baseRevision) ? { logs: selectChangedSince(mergedLogs, request.baseRevision) } : {}),
      ...(selectChangedSince(mergedWorkouts, request.baseRevision) ? { workouts: selectChangedSince(mergedWorkouts, request.baseRevision) } : {}),
      ...(selectProfileChangedSince(mergedProfile, request.baseRevision) ? { profile: selectProfileChangedSince(mergedProfile, request.baseRevision) } : {}),
    },
    conflicts,
  };

  const changed = normalizedChanged
    || conflicts.length > 0
    || state.revision !== normalizedCurrent.revision
    || JSON.stringify(nextData) !== JSON.stringify(current);

  return { data: nextData, response, changed };
}
