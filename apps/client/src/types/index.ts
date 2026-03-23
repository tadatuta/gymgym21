export type WorkoutStatus = 'active' | 'paused' | 'finished';

export interface SyncItem {
    updatedAt: string; // ISO
    isDeleted?: boolean;
}

export interface WorkoutSession extends SyncItem {
    id: string;
    startTime: string; // ISO
    endTime?: string; // ISO
    name?: string;
    status: WorkoutStatus;
    isManual: boolean; // Created via Start button
    pauseIntervals: { start: string; end?: string }[];
}

export interface WorkoutType extends SyncItem {
    id: string;
    name: string;
    category?: 'strength' | 'time'; // Default to 'strength' if undefined
    order?: number;
}

export interface WorkoutSet extends SyncItem {
    id: string;
    workoutTypeId: string;
    workoutId: string; // Linked to WorkoutSession
    reps?: number; // Optional for time-based
    weight?: number; // Optional for time-based
    duration?: number; // In minutes, for time-based
    durationSeconds?: number; // Additional seconds, for time-based
    date: string; // ISO string
}

export interface UserProfile extends SyncItem {
    id: string; // 'me' or telegram user id
    isPublic: boolean;
    showFullHistory?: boolean;
    displayName?: string;
    username?: string;
    photoUrl?: string;
    telegramUsername?: string;
    telegramUserId?: number;
    createdAt: string;
    // Personal Data for LLM (Private)
    gender?: 'male' | 'female' | 'other';
    birthDate?: string; // YYYY-MM-DD
    height?: number; // cm
    weight?: number; // kg (current weight)
    additionalInfo?: string; // Arbitrary text for LLM
    friends?: Friend[];
}

export interface Friend {
    identifier: string; // e.g., 'id_12345' or 'username'
    displayName: string;
    photoUrl?: string;
    addedAt: string; // ISO
}


export interface ProfileStats {
    totalWorkouts: number;
    totalVolume: number;
    favoriteExercise?: string;
    lastWorkoutDate?: string;
}

export interface PublicProfileData {
    displayName: string;
    photoUrl?: string;
    identifier: string; // username или id_123456
    stats: ProfileStats;
    recentActivity: {
        date: string;
        exerciseCount: number;
    }[];
    logs?: WorkoutSet[];
    workoutTypes?: WorkoutType[];
}

export interface AppData {
    workoutTypes: WorkoutType[];
    logs: WorkoutSet[];
    workouts: WorkoutSession[];
    profile?: UserProfile;
}
