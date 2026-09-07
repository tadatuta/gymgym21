import type {
    SyncMetadata, WorkoutType as WireWorkoutType, WorkoutSet as WireWorkoutSet,
    WorkoutSession as WireWorkoutSession, UserProfile as WireUserProfile,
    SyncRequest as WireSyncRequest, SyncResponse as WireSyncResponse,
    SyncEntityType, PublicProfileData as WirePublicProfileData,
} from '@gym21/contracts';
export type { WorkoutStatus, SyncEntityType, Friend, ProfileStats, SyncConflict, SyncAcknowledgement } from '@gym21/contracts';

// Local mutations stamp updatedAt and link a set to a session (or the legacy
// empty string). Wire contracts deliberately allow old records to omit both.
export type SyncItem = Omit<SyncMetadata, 'id' | 'updatedAt'> & { updatedAt: string };
export type WorkoutSession = WireWorkoutSession & SyncItem;
export type WorkoutType = WireWorkoutType & SyncItem;
export type WorkoutSet = WireWorkoutSet & SyncItem & { workoutId: string };
export type UserProfile = WireUserProfile & SyncItem;

export interface PublicProfileData extends WirePublicProfileData {
    cacheMetadata?: {
        cached: boolean;
        cachedAt: string;
    };
}

export interface AppData {
    workoutTypes: WorkoutType[];
    logs: WorkoutSet[];
    workouts: WorkoutSession[];
    profile?: UserProfile;
}

export interface DirtyEntityRecord {
    key: string;
    entityType: SyncEntityType;
    entityId: string;
    queuedAt: string;
    generation: string;
}

export interface SyncStateRecord {
    key: string;
    cursor: number;
    updatedAt: string;
}

export interface SyncConflictRecord {
    key: string;
    entityType: SyncEntityType;
    entityId: string;
    reason: 'stale-version';
    serverVersion: number;
    localPayload?: SyncItem;
    serverPayload?: SyncItem;
    createdAt: string;
}

export interface SyncDelta {
    workoutTypes?: WorkoutType[];
    logs?: WorkoutSet[];
    workouts?: WorkoutSession[];
    profile?: UserProfile;
}

export type SyncRequest = Omit<WireSyncRequest, 'changes'> & { changes: SyncDelta };
export type SyncResponse = Omit<WireSyncResponse, 'changes'> & { changes: SyncDelta };

export interface CachedPublicProfileRecord {
    identifier: string;
    payload: PublicProfileData;
    cachedAt: string;
}

export interface CachedAiResultRecord {
    type: 'general' | 'plan';
    markdown: string;
    updatedAt: string;
}
