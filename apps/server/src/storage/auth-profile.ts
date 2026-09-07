import { ensureDatabaseReady, getDatabasePool } from '../database.js';
import type { AuthenticatedRequestContext } from '../auth.js';
import { STORAGE_PROFILE_ID, sanitizeStorageKey } from './values.js';
import { normalizeProfileForWrite } from './profile.js';
import { ensureStorageRoot, updateStorageRootRevision, upsertProfile } from './write-repository.js';
import { readExistingProfile } from './read-repository.js';
import { refreshPublicAliases, invalidatePublicProfileCache } from './public-repository.js';

export async function updateProfileFromAuth(
  storageKeyInput: string | number,
  data: {
    username?: string | null;
    name?: string | null;
    image?: string | null;
    telegramUser?: AuthenticatedRequestContext['telegramUser'];
  },
): Promise<void> {
  await ensureDatabaseReady();
  const storageKey = sanitizeStorageKey(storageKeyInput);
  const client = await getDatabasePool().connect();

  try {
    await client.query('BEGIN');
    let revision = await ensureStorageRoot(client, storageKey);
    const existingProfile = await readExistingProfile(client, storageKey);
    const now = new Date().toISOString();
    const profile = normalizeProfileForWrite(
      {
        ...(existingProfile ?? {
          id: STORAGE_PROFILE_ID,
          isPublic: false,
          createdAt: now,
          updatedAt: now,
        }),
        ...(data.username ? { username: data.username } : {}),
        ...(!existingProfile?.displayName && data.name ? { displayName: data.name } : {}),
        ...(data.image ? { photoUrl: data.image } : {}),
        ...(data.telegramUser
          ? {
              telegramUserId: data.telegramUser.id,
              telegramUsername: data.telegramUser.username,
              photoUrl: data.telegramUser.photo_url ?? (data.image ?? existingProfile?.photoUrl),
            }
          : {}),
      },
      {
        existing: existingProfile,
        now,
      },
    );

    revision += 1;
    profile.version = revision;
    profile.serverUpdatedAt = now;

    await upsertProfile(client, storageKey, profile);
    await updateStorageRootRevision(client, storageKey, revision);
    await refreshPublicAliases(client, storageKey, profile);
    await invalidatePublicProfileCache(client, storageKey);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
