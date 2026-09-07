import type { StorageData, PublicProfileData, StorageRepository } from './storage/types.js';
import { readSnapshot, readAiContext } from './storage/read-repository.js';
import { replaceSnapshot } from './storage/import.js';
import { sync } from './storage/sync.js';
import { updateProfileFromAuth } from './storage/auth-profile.js';
import { findPublicProfileByIdentifier, getPublicProfileByStorageKey } from './storage/public-repository.js';

export type * from './storage/types.js';
export { normalizeProfileForWrite } from './storage/profile.js';
export { prepareImportedSnapshot, replaceSnapshotTx } from './storage/import.js';

/** PostgreSQL composition; each use case owns its transaction boundary. */
export const defaultStorageRepository: StorageRepository = {
  readSnapshot, replaceSnapshot, sync, updateProfileFromAuth, readAiContext,
  findPublicProfileByIdentifier, getPublicProfileByStorageKey,
};

export class Storage {
  static async read(storageKey: string | number): Promise<StorageData> {
    return defaultStorageRepository.readSnapshot(storageKey);
  }

  static async write(storageKey: string | number, data: StorageData): Promise<void> {
    return defaultStorageRepository.replaceSnapshot(storageKey, data);
  }

  static async getPublicProfile(identifier: string): Promise<PublicProfileData | null> {
    return defaultStorageRepository.findPublicProfileByIdentifier(identifier);
  }

  static async getPublicProfileByStorageKey(storageKey: string | number, fallbackIdentifier?: string): Promise<PublicProfileData | null> {
    return defaultStorageRepository.getPublicProfileByStorageKey(storageKey, fallbackIdentifier);
  }
}
