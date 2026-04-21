import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthenticatedRequestContext } from './auth.js';
import { config } from './config.js';
import { syncStorageData } from './services/storage-data.js';

function sanitizeStorageKey(storageKey: string | number): string {
  const sanitized = String(storageKey).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitized) {
    throw new Error('Invalid storage key');
  }
  return sanitized;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data));
  await fs.rename(tempPath, filePath);
}

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Ignore cache and optional-file cleanup failures.
  }
}

function hasChanged(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
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
  reps?: number;
  weight?: number;
  duration?: number;
  durationSeconds?: number;
  date: string;
  workoutId?: string;
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

export interface StorageSyncRequest {
  baseRevision: number;
  changes: {
    workoutTypes?: StorageWorkoutType[];
    logs?: StorageLogEntry[];
    workouts?: StorageWorkout[];
    profile?: StorageProfile;
  };
}

export interface StorageSyncResponse {
  revision: number;
  changes: {
    workoutTypes?: StorageWorkoutType[];
    logs?: StorageLogEntry[];
    workouts?: StorageWorkout[];
    profile?: StorageProfile;
  };
  conflicts: SyncConflict[];
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
  logs?: Pick<StorageLogEntry, 'id' | 'workoutTypeId' | 'reps' | 'weight' | 'duration' | 'durationSeconds' | 'date' | 'workoutId'>[];
  workoutTypes?: Pick<StorageWorkoutType, 'id' | 'name' | 'category'>[];
}

interface UsernameIndex {
  [username: string]: string;
}

interface StorageCollectionMeta {
  lastRevision: number;
}

interface StructuredStorageMeta {
  formatVersion: number;
  revision: number;
  collections: Record<SyncEntityType, StorageCollectionMeta>;
}

interface PublicProfileCache {
  sourceRevision: number;
  stats: PublicProfileData['stats'];
  recentActivity: PublicProfileData['recentActivity'];
  logs?: PublicProfileData['logs'];
  workoutTypes?: PublicProfileData['workoutTypes'];
}

const STORAGE_FORMAT_VERSION = 2;
const ARRAY_COLLECTIONS = ['workoutTypes', 'logs', 'workouts'] as const;

function maxVersion(items: Array<{ version?: number }> | undefined): number {
  return (items ?? []).reduce((max, item) => Math.max(max, item.version ?? 0), 0);
}

function buildStorageMeta(data: StorageData): StructuredStorageMeta {
  const collections: Record<SyncEntityType, StorageCollectionMeta> = {
    workoutTypes: { lastRevision: maxVersion(data.workoutTypes) },
    logs: { lastRevision: maxVersion(data.logs) },
    workouts: { lastRevision: maxVersion(data.workouts) },
    profile: { lastRevision: data.profile?.version ?? 0 },
  };

  return {
    formatVersion: STORAGE_FORMAT_VERSION,
    revision: Math.max(
      data.revision ?? 0,
      collections.workoutTypes.lastRevision,
      collections.logs.lastRevision,
      collections.workouts.lastRevision,
      collections.profile.lastRevision,
    ),
    collections,
  };
}

function buildPublicProfileFromCache(
  profile: StorageProfile,
  fallbackIdentifier: string,
  cache: PublicProfileCache,
): PublicProfileData {
  return {
    displayName: profile.displayName || profile.username || profile.telegramUsername || fallbackIdentifier,
    identifier: profile.username || profile.telegramUsername || fallbackIdentifier,
    photoUrl: profile.photoUrl,
    stats: cache.stats,
    recentActivity: cache.recentActivity,
    ...(profile.showFullHistory
      ? {
          logs: (cache.logs ?? []).map(({ id, workoutTypeId, reps, weight, duration, durationSeconds, date, workoutId }) => ({
            id,
            workoutTypeId,
            reps,
            weight,
            duration,
            durationSeconds,
            date,
            workoutId,
          })),
          workoutTypes: (cache.workoutTypes ?? []).map(({ id, name, category }) => ({
            id,
            name,
            category,
          })),
        }
      : {}),
  };
}

export interface StorageRepository {
  ensureStorageDir(): Promise<void>;
  readSnapshot(storageKey: string | number): Promise<StorageData>;
  replaceSnapshot(storageKey: string | number, data: StorageData): Promise<void>;
  sync(
    storageKey: string | number,
    request: StorageSyncRequest,
    authContext: AuthenticatedRequestContext,
  ): Promise<StorageSyncResponse>;
  exists(storageKey: string | number): Promise<boolean>;
  updateUsernameIndex(username: string, storageKey: string | number): Promise<void>;
  readUsernameIndex(): Promise<UsernameIndex>;
  findUserIdByIdentifier(identifier: string): Promise<string | null>;
  getPublicProfileByStorageKey(
    storageKey: string | number,
    fallbackIdentifier?: string,
  ): Promise<PublicProfileData | null>;
  getPublicProfile(identifier: string): Promise<PublicProfileData | null>;
}

class FileStorageRepository implements StorageRepository {
  private readonly locks = new Map<string, Promise<void>>();

  async ensureStorageDir(): Promise<void> {
    await fs.mkdir(config.STORAGE_DIR, { recursive: true });
  }

  async readSnapshot(storageKey: string | number): Promise<StorageData> {
    await this.ensureStorageDir();
    const safeKey = sanitizeStorageKey(storageKey);
    await this.ensureStructuredStorage(safeKey);

    if (!(await this.hasStructuredStorage(safeKey))) {
      return {};
    }

    return this.readStructuredSnapshot(safeKey);
  }

  async replaceSnapshot(storageKey: string | number, data: StorageData): Promise<void> {
    await this.ensureStorageDir();
    const safeKey = sanitizeStorageKey(storageKey);

    await this.withLock(safeKey, async () => {
      await this.ensureStructuredStorageUnlocked(safeKey);
      const previous = await this.readStructuredSnapshot(safeKey);
      await this.persistStructuredSnapshot(safeKey, data, { previous, writeAll: true });
    });
  }

  async sync(
    storageKey: string | number,
    request: StorageSyncRequest,
    authContext: AuthenticatedRequestContext,
  ): Promise<StorageSyncResponse> {
    await this.ensureStorageDir();
    const safeKey = sanitizeStorageKey(storageKey);

    return this.withLock(safeKey, async () => {
      await this.ensureStructuredStorageUnlocked(safeKey);
      const current = await this.readStructuredSnapshot(safeKey);
      const { data, response, changed } = syncStorageData(current, request, authContext);

      if (changed) {
        await this.persistStructuredSnapshot(safeKey, data, { previous: current, writeAll: false });
      }

      return response;
    });
  }

  async exists(storageKey: string | number): Promise<boolean> {
    await this.ensureStorageDir();
    const safeKey = sanitizeStorageKey(storageKey);
    return (await this.hasStructuredStorage(safeKey)) || (await pathExists(this.getLegacyDataFilePath(safeKey)));
  }

  async updateUsernameIndex(username: string, storageKey: string | number): Promise<void> {
    await this.ensureStorageDir();
    const index = await this.readUsernameIndex();
    index[username.toLowerCase()] = String(storageKey);
    await writeJsonFile(this.getIndexFilePath(), index);
  }

  async readUsernameIndex(): Promise<UsernameIndex> {
    await this.ensureStorageDir();
    return (await readJsonFile<UsernameIndex>(this.getIndexFilePath())) ?? {};
  }

  async findUserIdByIdentifier(identifier: string): Promise<string | null> {
    const normalizedIdentifier = identifier.replace(/^@/, '');

    if (normalizedIdentifier.startsWith('id_')) {
      const rawId = normalizedIdentifier.replace('id_', '');
      try {
        return sanitizeStorageKey(rawId);
      } catch {
        return null;
      }
    }

    const usernameRegex = /^[a-zA-Z0-9_]{5,32}$/;
    if (!usernameRegex.test(normalizedIdentifier)) {
      return null;
    }

    const index = await this.readUsernameIndex();
    return index[normalizedIdentifier.toLowerCase()] || null;
  }

  async getPublicProfileByStorageKey(
    storageKey: string | number,
    fallbackIdentifier?: string,
  ): Promise<PublicProfileData | null> {
    await this.ensureStorageDir();
    const safeKey = sanitizeStorageKey(storageKey);
    await this.ensureStructuredStorage(safeKey);

    if (!(await this.hasStructuredStorage(safeKey))) {
      return null;
    }

    const [meta, profile, cache] = await Promise.all([
      this.readStructuredMeta(safeKey),
      this.readProfileFile(safeKey),
      readJsonFile<PublicProfileCache>(this.getPublicProfileCacheFilePath(safeKey)),
    ]);

    if (!profile?.isPublic) {
      return null;
    }

    const resolvedIdentifier = fallbackIdentifier || `id_${safeKey}`;
    if (cache && cache.sourceRevision === meta.revision) {
      return buildPublicProfileFromCache(profile, resolvedIdentifier, cache);
    }

    const snapshot = await this.readPublicProfileSnapshot(safeKey);
    const publicProfile = Storage.buildPublicProfile(snapshot, resolvedIdentifier);
    if (!publicProfile) {
      return null;
    }

    await writeJsonFile(this.getPublicProfileCacheFilePath(safeKey), {
      sourceRevision: meta.revision,
      stats: publicProfile.stats,
      recentActivity: publicProfile.recentActivity,
      logs: publicProfile.logs,
      workoutTypes: publicProfile.workoutTypes,
    } satisfies PublicProfileCache);

    return publicProfile;
  }

  async getPublicProfile(identifier: string): Promise<PublicProfileData | null> {
    const storageKey = await this.findUserIdByIdentifier(identifier);
    if (!storageKey) return null;

    return this.getPublicProfileByStorageKey(
      storageKey,
      identifier.startsWith('id_') ? identifier : `id_${storageKey}`,
    );
  }

  private async withLock<T>(safeKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(safeKey) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => pending);
    this.locks.set(safeKey, chain);

    await previous;

    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(safeKey) === chain) {
        this.locks.delete(safeKey);
      }
    }
  }

  private getIndexFilePath(): string {
    return path.join(config.STORAGE_DIR, 'username_index.json');
  }

  private getStructuredStorageDirPath(safeKey: string): string {
    return path.join(config.STORAGE_DIR, safeKey);
  }

  private getLegacyDataFilePath(safeKey: string): string {
    return path.join(config.STORAGE_DIR, `${safeKey}.json`);
  }

  private getMetaFilePath(safeKey: string): string {
    return path.join(this.getStructuredStorageDirPath(safeKey), 'meta.json');
  }

  private getProfileFilePath(safeKey: string): string {
    return path.join(this.getStructuredStorageDirPath(safeKey), 'profile.json');
  }

  private getCollectionFilePath(safeKey: string, collection: (typeof ARRAY_COLLECTIONS)[number]): string {
    return path.join(this.getStructuredStorageDirPath(safeKey), `${collection}.json`);
  }

  private getPublicProfileCacheFilePath(safeKey: string): string {
    return path.join(this.getStructuredStorageDirPath(safeKey), 'public-profile-cache.json');
  }

  private async hasStructuredStorage(safeKey: string): Promise<boolean> {
    return pathExists(this.getStructuredStorageDirPath(safeKey));
  }

  private async ensureStructuredStorage(safeKey: string): Promise<void> {
    if ((await this.hasStructuredStorage(safeKey)) || !(await pathExists(this.getLegacyDataFilePath(safeKey)))) {
      return;
    }

    await this.withLock(safeKey, async () => {
      await this.ensureStructuredStorageUnlocked(safeKey);
    });
  }

  private async ensureStructuredStorageUnlocked(safeKey: string): Promise<void> {
    if ((await this.hasStructuredStorage(safeKey)) || !(await pathExists(this.getLegacyDataFilePath(safeKey)))) {
      return;
    }

    const legacySnapshot = await readJsonFile<StorageData>(this.getLegacyDataFilePath(safeKey));
    if (!legacySnapshot) {
      return;
    }

    await this.persistStructuredSnapshot(safeKey, legacySnapshot, { writeAll: true });
  }

  private async readStructuredMeta(safeKey: string): Promise<StructuredStorageMeta> {
    return (await readJsonFile<StructuredStorageMeta>(this.getMetaFilePath(safeKey))) ?? buildStorageMeta({});
  }

  private async readCollectionFile<T>(safeKey: string, collection: (typeof ARRAY_COLLECTIONS)[number]): Promise<T[]> {
    const value = await readJsonFile<T[]>(this.getCollectionFilePath(safeKey, collection));
    return Array.isArray(value) ? value : [];
  }

  private async readProfileFile(safeKey: string): Promise<StorageProfile | undefined> {
    const value = await readJsonFile<StorageProfile>(this.getProfileFilePath(safeKey));
    return value ?? undefined;
  }

  private async readStructuredSnapshot(safeKey: string): Promise<StorageData> {
    if (!(await this.hasStructuredStorage(safeKey))) {
      return {};
    }

    const [meta, workoutTypes, logs, workouts, profile] = await Promise.all([
      this.readStructuredMeta(safeKey),
      this.readCollectionFile<StorageWorkoutType>(safeKey, 'workoutTypes'),
      this.readCollectionFile<StorageLogEntry>(safeKey, 'logs'),
      this.readCollectionFile<StorageWorkout>(safeKey, 'workouts'),
      this.readProfileFile(safeKey),
    ]);

    const data: StorageData = {};
    const revision = Math.max(
      meta.revision ?? 0,
      maxVersion(workoutTypes),
      maxVersion(logs),
      maxVersion(workouts),
      profile?.version ?? 0,
    );

    if (revision > 0) {
      data.revision = revision;
    }
    if (workoutTypes.length > 0) {
      data.workoutTypes = workoutTypes;
    }
    if (logs.length > 0) {
      data.logs = logs;
    }
    if (workouts.length > 0) {
      data.workouts = workouts;
    }
    if (profile) {
      data.profile = profile;
    }

    return data;
  }

  private async readPublicProfileSnapshot(safeKey: string): Promise<StorageData> {
    const [meta, workoutTypes, logs, profile] = await Promise.all([
      this.readStructuredMeta(safeKey),
      this.readCollectionFile<StorageWorkoutType>(safeKey, 'workoutTypes'),
      this.readCollectionFile<StorageLogEntry>(safeKey, 'logs'),
      this.readProfileFile(safeKey),
    ]);

    return {
      revision: meta.revision,
      workoutTypes,
      logs,
      ...(profile ? { profile } : {}),
    };
  }

  private async persistStructuredSnapshot(
    safeKey: string,
    data: StorageData,
    options: { previous?: StorageData; writeAll: boolean },
  ): Promise<void> {
    const userDir = this.getStructuredStorageDirPath(safeKey);
    await fs.mkdir(userDir, { recursive: true });

    const nextMeta = buildStorageMeta(data);
    const previous = options.previous;
    const writes: Promise<void>[] = [];

    for (const collection of ARRAY_COLLECTIONS) {
      const previousValue = previous?.[collection];
      const nextValue = data[collection];
      if (options.writeAll || hasChanged(previousValue, nextValue)) {
        writes.push(writeJsonFile(this.getCollectionFilePath(safeKey, collection), cloneValue(nextValue ?? [])));
      }
    }

    if (options.writeAll || hasChanged(previous?.profile, data.profile)) {
      if (data.profile) {
        writes.push(writeJsonFile(this.getProfileFilePath(safeKey), cloneValue(data.profile)));
      } else {
        writes.push(removeFileIfExists(this.getProfileFilePath(safeKey)));
      }
    }

    if (options.writeAll || !previous || hasChanged(buildStorageMeta(previous), nextMeta)) {
      writes.push(writeJsonFile(this.getMetaFilePath(safeKey), nextMeta));
    }

    if (
      options.writeAll
      || hasChanged(previous?.profile, data.profile)
      || hasChanged(previous?.logs, data.logs)
      || hasChanged(previous?.workoutTypes, data.workoutTypes)
    ) {
      writes.push(removeFileIfExists(this.getPublicProfileCacheFilePath(safeKey)));
    }

    await Promise.all(writes);

    if (data.profile?.telegramUsername) {
      await this.updateUsernameIndex(data.profile.telegramUsername, safeKey);
    }
  }
}

export const defaultStorageRepository: StorageRepository = new FileStorageRepository();

export class Storage {
  static async ensureStorageDir(): Promise<void> {
    await defaultStorageRepository.ensureStorageDir();
  }

  static async read(storageKey: string | number): Promise<StorageData> {
    return defaultStorageRepository.readSnapshot(storageKey);
  }

  static async exists(storageKey: string | number): Promise<boolean> {
    return defaultStorageRepository.exists(storageKey);
  }

  static async write(storageKey: string | number, data: StorageData): Promise<void> {
    await defaultStorageRepository.replaceSnapshot(storageKey, data);
  }

  static async updateUsernameIndex(username: string, storageKey: string | number): Promise<void> {
    await defaultStorageRepository.updateUsernameIndex(username, storageKey);
  }

  static async readUsernameIndex(): Promise<UsernameIndex> {
    return defaultStorageRepository.readUsernameIndex();
  }

  static async findUserIdByIdentifier(identifier: string): Promise<string | null> {
    return defaultStorageRepository.findUserIdByIdentifier(identifier);
  }

  static buildPublicProfile(data: StorageData, fallbackIdentifier: string): PublicProfileData | null {
    if (!data.profile?.isPublic) return null;

    const workoutTypes = data.workoutTypes || [];
    const activeWorkoutTypes = workoutTypes.filter((entry) => !entry.isDeleted);
    const activeWorkoutTypeIds = new Set(activeWorkoutTypes.map((entry) => entry.id));
    const activeLogs = (data.logs || []).filter((entry) => !entry.isDeleted && activeWorkoutTypeIds.has(entry.workoutTypeId));

    const totalVolume = activeLogs.reduce((acc, entry) => acc + ((entry.weight || 0) * (entry.reps || 0)), 0);
    const uniqueDays = new Set(activeLogs.map((entry) => entry.date.split('T')[0]));

    const exerciseCounts: Record<string, number> = {};
    activeLogs.forEach((entry) => {
      exerciseCounts[entry.workoutTypeId] = (exerciseCounts[entry.workoutTypeId] || 0) + 1;
    });

    const favoriteTypeId = Object.entries(exerciseCounts)
      .sort(([, left], [, right]) => right - left)[0]?.[0];
    const favoriteExercise = activeWorkoutTypes.find((entry) => entry.id === favoriteTypeId)?.name;

    const sortedLogs = [...activeLogs].sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
    const lastWorkoutDate = sortedLogs[0]?.date;

    const recentDays: Record<string, number> = {};
    sortedLogs.slice(0, 100).forEach((entry) => {
      const day = entry.date.split('T')[0];
      recentDays[day] = (recentDays[day] || 0) + 1;
    });

    const recentActivity = Object.entries(recentDays)
      .slice(0, 7)
      .map(([date, count]) => ({ date, exerciseCount: count }));

    return {
      displayName: data.profile.displayName || data.profile.username || data.profile.telegramUsername || fallbackIdentifier,
      identifier: data.profile.username || data.profile.telegramUsername || fallbackIdentifier,
      photoUrl: data.profile.photoUrl,
      stats: {
        totalWorkouts: uniqueDays.size,
        totalVolume,
        favoriteExercise,
        lastWorkoutDate,
      },
      recentActivity,
      ...(data.profile.showFullHistory
        ? {
            logs: activeLogs
              .map(({ id, workoutTypeId, reps, weight, duration, durationSeconds, date, workoutId }) => ({
                id,
                workoutTypeId,
                reps,
                weight,
                duration,
                durationSeconds,
                date,
                workoutId,
              })),
            workoutTypes: activeWorkoutTypes
              .map(({ id, name, category }) => ({ id, name, category })),
          }
        : {}),
    };
  }

  static async getPublicProfileByStorageKey(
    storageKey: string | number,
    fallbackIdentifier?: string,
  ): Promise<PublicProfileData | null> {
    return defaultStorageRepository.getPublicProfileByStorageKey(storageKey, fallbackIdentifier);
  }

  static async getPublicProfile(identifier: string): Promise<PublicProfileData | null> {
    return defaultStorageRepository.getPublicProfile(identifier);
  }
}
