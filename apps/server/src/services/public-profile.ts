import { defaultStorageRepository, type PublicProfileData } from '../storage.js';

export async function findPublicProfileByIdentifier(identifier: string, cursor?: string): Promise<PublicProfileData | null> {
  return defaultStorageRepository.findPublicProfileByIdentifier(identifier, cursor);
}
