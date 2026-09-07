import type { MigrationStatus } from '../auth';
import type { AppRoute } from '../router';
import { createInternalRoute } from '../router';
import type { SyncStatus } from '../storage/storage';
import type { PublicProfileData } from '../types';
import type { FormDrafts } from '../utils/form-drafts';
export type AiRecommendationType = 'general' | 'plan';
export type AiResultsState = Record<AiRecommendationType, string | null>;
export interface UiState {
  currentRoute: AppRoute;
  selectedStatType: string;
  editingLogId: string | null;
  loadedPublicProfile: PublicProfileData | null;
  loadedPublicProfileIdentifier: string | null;
  profileLoadFailed: boolean;
  publicProfileLoadError: string | null;
  guestLoginRequested: boolean;
  guestLoginHost: HTMLElement | null;
  lastAddedLogId: string | null;
  editingTypeId: string | null;
  currentStatsTab: 'overview' | 'progress';
  currentProfileTab: 'ai' | 'public' | 'data';
  isFilterEnabled: boolean;
  authStatus: MigrationStatus | null;
  aiResults: AiResultsState;
  aiLoadingState: 'idle' | 'general' | 'plan';
  isStartingWorkout: boolean;
  editingWorkoutId: string | null;
  publicProfileRequestId: number;
  formDrafts: FormDrafts | null;
  syncStatus: SyncStatus;
  currentWeekOffset: number;
  lastCalendarValue: string;
}
export function createUiState(): UiState {
  return {
    currentRoute: createInternalRoute('main'),
    selectedStatType: 'all',
    editingLogId: null,
    loadedPublicProfile: null,
    loadedPublicProfileIdentifier: null,
    profileLoadFailed: false,
    publicProfileLoadError: null,
    guestLoginRequested: false,
    guestLoginHost: null,
    lastAddedLogId: null,
    editingTypeId: null,
    currentStatsTab: 'overview',
    currentProfileTab: 'ai',
    isFilterEnabled: false,
    authStatus: null,
    aiResults: { general: null, plan: null },
    aiLoadingState: 'idle',
    isStartingWorkout: false,
    editingWorkoutId: null,
    publicProfileRequestId: 0,
    formDrafts: null,
    syncStatus: 'idle',
    currentWeekOffset: 0,
    lastCalendarValue: '',
  };
}
