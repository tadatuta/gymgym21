import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

function sanitizeStorageKey(storageKey: string | number): string {
  const sanitized = String(storageKey).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitized) {
    throw new Error('Invalid storage key');
  }
  return sanitized;
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
}

export interface StorageData {
  workoutTypes?: StorageWorkoutType[];
  logs?: StorageLogEntry[];
  workouts?: StorageWorkout[];
  profile?: StorageProfile;
  [key: string]: unknown;
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

export class Storage {
  private static getIndexFilePath(): string {
    return path.join(config.STORAGE_DIR, 'username_index.json');
  }

  static async ensureStorageDir(): Promise<void> {
    await fs.mkdir(config.STORAGE_DIR, { recursive: true });
  }

  private static getDataFilePath(storageKey: string | number): string {
    const safeKey = sanitizeStorageKey(storageKey);
    return path.join(config.STORAGE_DIR, `${safeKey}.json`);
  }

  static async read(storageKey: string | number): Promise<StorageData> {
    await this.ensureStorageDir();

    try {
      const content = await fs.readFile(this.getDataFilePath(storageKey), 'utf-8');
      return JSON.parse(content) as StorageData;
    } catch {
      // Missing storage is a valid empty state for new users.
    }

    return {};
  }

  static async exists(storageKey: string | number): Promise<boolean> {
    await this.ensureStorageDir();

    try {
      await fs.access(this.getDataFilePath(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  static async write(storageKey: string | number, data: StorageData): Promise<void> {
    await this.ensureStorageDir();
    await fs.writeFile(this.getDataFilePath(storageKey), JSON.stringify(data));

    if (data.profile?.telegramUsername) {
      await this.updateUsernameIndex(data.profile.telegramUsername, storageKey);
    }
  }

  static async updateUsernameIndex(username: string, storageKey: string | number): Promise<void> {
    await this.ensureStorageDir();
    const index = await this.readUsernameIndex();
    index[username.toLowerCase()] = String(storageKey);
    await fs.writeFile(this.getIndexFilePath(), JSON.stringify(index));
  }

  static async readUsernameIndex(): Promise<UsernameIndex> {
    await this.ensureStorageDir();

    try {
      const content = await fs.readFile(this.getIndexFilePath(), 'utf-8');
      return JSON.parse(content) as UsernameIndex;
    } catch {
      return {};
    }
  }

  static async findUserIdByIdentifier(identifier: string): Promise<string | null> {
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

  static buildPublicProfile(data: StorageData, fallbackIdentifier: string): PublicProfileData | null {
    if (!data.profile?.isPublic) return null;

    const logs = data.logs || [];
    const workoutTypes = data.workoutTypes || [];

    const totalVolume = logs.reduce((acc, entry) => acc + ((entry.weight || 0) * (entry.reps || 0)), 0);
    const uniqueDays = new Set(logs.map((entry) => entry.date.split('T')[0]));

    const exerciseCounts: Record<string, number> = {};
    logs.forEach((entry) => {
      exerciseCounts[entry.workoutTypeId] = (exerciseCounts[entry.workoutTypeId] || 0) + 1;
    });

    const favoriteTypeId = Object.entries(exerciseCounts)
      .sort(([, left], [, right]) => right - left)[0]?.[0];
    const favoriteExercise = workoutTypes.find((entry) => entry.id === favoriteTypeId)?.name;

    const sortedLogs = [...logs].sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
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
            logs: logs
              .filter((entry) => !entry.isDeleted)
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
            workoutTypes: workoutTypes
              .filter((entry) => !entry.isDeleted)
              .map(({ id, name, category }) => ({ id, name, category })),
          }
        : {}),
    };
  }

  static async getPublicProfileByStorageKey(
    storageKey: string | number,
    fallbackIdentifier?: string,
  ): Promise<PublicProfileData | null> {
    const data = await this.read(storageKey);
    return this.buildPublicProfile(data, fallbackIdentifier || `id_${storageKey}`);
  }

  static async getPublicProfile(identifier: string): Promise<PublicProfileData | null> {
    const storageKey = await this.findUserIdByIdentifier(identifier);
    if (!storageKey) return null;
    return this.getPublicProfileByStorageKey(
      storageKey,
      identifier.startsWith('id_') ? identifier : `id_${storageKey}`,
    );
  }
}
