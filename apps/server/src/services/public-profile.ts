import { AuthMetaService } from '../auth-meta.js';
import { HAS_DATABASE } from '../config.js';
import { Storage, type PublicProfileData } from '../storage.js';

export async function findPublicProfileByIdentifier(identifier: string): Promise<PublicProfileData | null> {
  const normalizedIdentifier = identifier.trim();

  if (!normalizedIdentifier) {
    return null;
  }

  if (HAS_DATABASE) {
    const storageKey = await AuthMetaService.resolveStorageKeyByIdentifier(normalizedIdentifier);
    if (storageKey) {
      return Storage.getPublicProfileByStorageKey(storageKey, normalizedIdentifier);
    }
  }

  return Storage.getPublicProfile(normalizedIdentifier);
}
