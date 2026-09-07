import type { StoragePauseInterval, StorageFriend, SyncEntityType, StorageSyncResponse, PublicProfileData } from './types.js';

export interface RevisionRow {
  server_revision: string | number;
}

export interface AliasRow {
  storage_key: string;
}

export interface CacheRow {
  source_revision: string | number;
  payload: PublicProfileData;
}

export interface RootRow {
  server_revision: string | number;
}

export interface ChangedEntityRow {
  entity_type: SyncEntityType;
  entity_id: string;
  version: string | number;
}

// Receipts record push outcomes only; cursors and entity data must always be read fresh.
export type SyncPushReceipt = Pick<StorageSyncResponse, 'conflicts' | 'acknowledged'>;

export interface SyncReceiptRow {
  response_payload: SyncPushReceipt | string;
}

export interface StorageProfileRow {
  profile_id: string;
  time_zone: string | null;
  is_public: boolean;
  show_full_history: boolean;
  display_name: string | null;
  username: string | null;
  telegram_username: string | null;
  telegram_user_id: string | number | null;
  photo_url: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  is_deleted: boolean;
  gender: 'male' | 'female' | 'other' | null;
  birth_date: string | Date | null;
  height: number | null;
  weight: number | null;
  additional_info: string | null;
  friends_json: StorageFriend[] | null;
  version: string | number;
  server_updated_at: string | Date;
}

export interface StorageWorkoutTypeRow {
  id: string;
  name: string;
  category: 'strength' | 'time' | null;
  sort_order: number | null;
  updated_at: string | Date;
  is_deleted: boolean;
  version: string | number;
  server_updated_at: string | Date;
}

export interface StorageWorkoutRow {
  id: string;
  start_time: string | Date;
  end_time: string | Date | null;
  name: string | null;
  status: string;
  is_manual: boolean;
  pause_intervals_json: StoragePauseInterval[] | null;
  updated_at: string | Date;
  is_deleted: boolean;
  version: string | number;
  server_updated_at: string | Date;
}

export interface StorageLogRow {
  id: string;
  workout_type_id: string;
  workout_id: string | null;
  reps: number | null;
  weight: number | null;
  duration: number | null;
  duration_seconds: number | null;
  logged_at: string | Date;
  updated_at: string | Date;
  is_deleted: boolean;
  version: string | number;
  server_updated_at: string | Date;
}
