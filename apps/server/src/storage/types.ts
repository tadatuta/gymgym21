import type { AuthenticatedRequestContext } from '../auth.js';
import type {
  WorkoutType as StorageWorkoutType, WorkoutSet as StorageLogEntry,
  WorkoutSession as StorageWorkout, UserProfile as StorageProfile,
  SyncRequest, SyncChanges, CompleteSyncResponse, PublicProfileData,
} from '@gym21/contracts';
export type {
  WorkoutType as StorageWorkoutType, WorkoutSet as StorageLogEntry,
  WorkoutSession as StorageWorkout, UserProfile as StorageProfile,
  PauseInterval as StoragePauseInterval, Friend as StorageFriend,
  SyncEntityType, SyncConflict, SyncAcknowledgement, PublicProfileData,
} from '@gym21/contracts';

export interface StorageData {
  revision?: number;
  workoutTypes?: StorageWorkoutType[];
  logs?: StorageLogEntry[];
  workouts?: StorageWorkout[];
  profile?: StorageProfile;
  [key: string]: unknown;
}

// Repository input also serves backup/CLI normalization, whose legacy profile
// IDs are not yet the canonical HTTP sync ID. HTTP parses SyncRequest first.
export type StorageSyncRequest = Omit<SyncRequest, 'changes'> & {
  changes: Omit<SyncChanges, 'profile'> & { profile?: StorageProfile | null };
};
export type StorageSyncResponse = CompleteSyncResponse;

export interface AIStorageContext {
  profile?: StorageProfile;
  logs: StorageLogEntry[];
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
  findPublicProfileByIdentifier(identifier: string, cursor?: string): Promise<PublicProfileData | null>;
  getPublicProfileByStorageKey(storageKey: string | number, fallbackIdentifier?: string, cursor?: string): Promise<PublicProfileData | null>;
}
