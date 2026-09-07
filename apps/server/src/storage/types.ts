import type { AuthenticatedRequestContext } from '../auth.js';

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
  timeZone?: string;
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
  timeZone?: string;
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
  sync(storageKey: string | number, request: StorageSyncRequest, authContext: AuthenticatedRequestContext, backup?: { mode: 'merge' | 'replace'; expectedRevision: number }): Promise<StorageSyncResponse>;
  updateProfileFromAuth(storageKey: string | number, data: {
    username?: string | null;
    name?: string | null;
    image?: string | null;
    telegramUser?: AuthenticatedRequestContext['telegramUser'];
  }): Promise<void>;
  readAiContext(storageKey: string | number, expectedRevision?: number): Promise<AIStorageContext>;
  findPublicProfileByIdentifier(identifier: string): Promise<PublicProfileData | null>;
  getPublicProfileByStorageKey(storageKey: string | number, fallbackIdentifier?: string): Promise<PublicProfileData | null>;
}
