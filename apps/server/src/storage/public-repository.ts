import type { PoolClient } from 'pg';
import { accountTimeZone } from '../training-time.js';
import { getTrainingActivity } from '../training-activity.js';
import { ensureDatabaseReady, getDatabasePool } from '../database.js';
import { AuthMetaService, ensureAuthDatabaseSchema } from '../auth-meta.js';
import type { StorageWorkoutType, StorageLogEntry, StorageProfile, PublicProfileData } from './types.js';
import type { AliasRow, CacheRow, RootRow, StorageProfileRow, StorageWorkoutTypeRow, StorageLogRow } from './rows.js';
import { sanitizeStorageKey, normalizeAlias, toNumber } from './values.js';
import { mapProfileRow, mapWorkoutTypeRow, mapLogRow } from './row-mappers.js';

export function buildPublicProfile(
  profile: StorageProfile,
  workoutTypes: StorageWorkoutType[],
  logs: StorageLogEntry[],
  fallbackIdentifier: string,
): PublicProfileData {
  const visibleWorkoutTypes = workoutTypes.filter((entry) => !entry.isDeleted);
  const visibleLogs = logs.filter((entry) => !entry.isDeleted);

  const totalVolume = visibleLogs.reduce((total, entry) => total + ((entry.weight ?? 0) * (entry.reps ?? 0)), 0);
  const favoriteExerciseId = visibleLogs.reduce<Map<string, number>>((counts, entry) => {
    counts.set(entry.workoutTypeId, (counts.get(entry.workoutTypeId) ?? 0) + 1);
    return counts;
  }, new Map());

  const favoriteExercise = [...favoriteExerciseId.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0];

  const favoriteExerciseName = favoriteExercise
    ? visibleWorkoutTypes.find((entry) => entry.id === favoriteExercise)?.name
    : undefined;

  const recentActivityMap = getTrainingActivity(visibleLogs, accountTimeZone(profile.timeZone));

  const recentActivity = [...recentActivityMap.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(-14)
    .map(([date, exerciseCount]) => ({ date, exerciseCount }));

  return {
    timeZone: accountTimeZone(profile.timeZone),
    displayName: profile.displayName || profile.username || profile.telegramUsername || fallbackIdentifier,
    identifier: profile.username || profile.telegramUsername || fallbackIdentifier,
    photoUrl: profile.photoUrl,
    stats: {
      totalWorkouts: recentActivityMap.size,
      totalVolume,
      favoriteExercise: favoriteExerciseName,
      lastWorkoutDate: visibleLogs.length > 0
        ? [...visibleLogs].sort((left, right) => left.date.localeCompare(right.date)).at(-1)?.date
        : undefined,
    },
    recentActivity,
    ...(profile.showFullHistory
      ? {
          logs: visibleLogs,
          workoutTypes: visibleWorkoutTypes,
        }
      : {}),
  };
}

export async function refreshPublicAliases(client: PoolClient, storageKey: string, profile: StorageProfile | undefined) {
  const desired = new Map<string, { alias: string; type: string }>();
  desired.set(`id_${storageKey}`.toLowerCase(), { alias: `id_${storageKey}`, type: 'storage_id' });

  await ensureAuthDatabaseSchema();
  const binding = await client.query<{ user_id: string }>(
    'SELECT user_id FROM user_storage_binding WHERE storage_key = $1', [storageKey],
  );
  if (profile && !profile.isDeleted && binding.rows[0]) {
    // Bound accounts publish only identifiers actually owned in the auth registry.
    const aliases = await client.query<{ alias: string; type: string }>(
      "SELECT alias, type FROM user_alias WHERE user_id = $1 AND type IN ('canonical', 'telegram_username')",
      [binding.rows[0].user_id],
    );
    for (const entry of aliases.rows) {
      desired.set(normalizeAlias(entry.alias), { alias: entry.alias, type: entry.type === 'canonical' ? 'canonical_username' : entry.type });
    }
  } else if (profile && !profile.isDeleted) {
    if (profile.username) {
      const alias = normalizeAlias(profile.username);
      desired.set(alias, { alias: profile.username, type: 'canonical_username' });
    }

    if (profile.telegramUsername) {
      const alias = normalizeAlias(profile.telegramUsername);
      desired.set(alias, { alias: profile.telegramUsername, type: 'telegram_username' });
    }
  }

  await client.query('DELETE FROM public_profile_aliases WHERE storage_key = $1', [storageKey]);

  for (const entry of [...desired.values()].sort((a, b) => normalizeAlias(a.alias).localeCompare(normalizeAlias(b.alias)))) {
    const aliasLower = normalizeAlias(entry.alias);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gym21-alias:${aliasLower}`]);
    const foreignOwner = await client.query(
      `SELECT 1 FROM user_alias a WHERE a.alias_lower = $1 AND NOT EXISTS (
        SELECT 1 FROM user_storage_binding b WHERE b.user_id = a.user_id AND b.storage_key = $2
      )`, [aliasLower, storageKey],
    );
    if (foreignOwner.rowCount) continue;
    await client.query(
      `
        INSERT INTO public_profile_aliases (alias_lower, alias, storage_key, type, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (alias_lower)
        DO UPDATE SET alias = EXCLUDED.alias, type = EXCLUDED.type, updated_at = NOW()
        WHERE public_profile_aliases.storage_key = EXCLUDED.storage_key
      `,
      [normalizeAlias(entry.alias), entry.alias, storageKey, entry.type],
    );
  }
}

export async function invalidatePublicProfileCache(client: PoolClient, storageKey: string) {
  await client.query('DELETE FROM public_profile_cache WHERE storage_key = $1', [storageKey]);
}

export async function findPublicProfileByIdentifier(identifier: string): Promise<PublicProfileData | null> {
  await ensureDatabaseReady();
  const normalizedIdentifier = normalizeAlias(identifier);
  if (!normalizedIdentifier) {
    return null;
  }

  const authoritativeAlias = await AuthMetaService.getAlias(normalizedIdentifier);
  const result = await getDatabasePool().query<AliasRow>(
    'SELECT storage_key FROM public_profile_aliases WHERE alias_lower = $1 LIMIT 1',
    [normalizedIdentifier],
  );
  const publicStorageKey = result.rows[0]?.storage_key;
  // An owned alias without a binding, or conflicting historical ownership,
  // must never resolve to somebody else's public profile.
  if (authoritativeAlias && (!authoritativeAlias.storageKey ||
    (publicStorageKey && publicStorageKey !== authoritativeAlias.storageKey))) return null;
  const storageKey = authoritativeAlias?.storageKey ?? publicStorageKey;
  if (!storageKey) {
    return null;
  }

  return getPublicProfileByStorageKey(storageKey, identifier);
}

export async function getPublicProfileByStorageKey(
  storageKeyInput: string | number,
  fallbackIdentifier?: string,
): Promise<PublicProfileData | null> {
  await ensureDatabaseReady();
  const storageKey = sanitizeStorageKey(storageKeyInput);
  const pool = getDatabasePool();

  const [rootResult, profileResult] = await Promise.all([
    pool.query<RootRow>('SELECT server_revision FROM storage_roots WHERE storage_key = $1 LIMIT 1', [storageKey]),
    pool.query<StorageProfileRow>('SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1', [storageKey]),
  ]);

  const revision = toNumber(rootResult.rows[0]?.server_revision);
  const profile = mapProfileRow(profileResult.rows[0]);
  if (!profile || profile.isDeleted || !profile.isPublic) {
    return null;
  }

  const cacheResult = await pool.query<CacheRow>(
    'SELECT source_revision, payload FROM public_profile_cache WHERE storage_key = $1 LIMIT 1',
    [storageKey],
  );
  const cached = cacheResult.rows[0];
  if (cached && toNumber(cached.source_revision) === revision) {
    return cached.payload;
  }

  const [workoutTypeResult, logResult] = await Promise.all([
    pool.query<StorageWorkoutTypeRow>(
      'SELECT * FROM storage_workout_types WHERE storage_key = $1 ORDER BY updated_at DESC, id ASC',
      [storageKey],
    ),
    pool.query<StorageLogRow>(
      'SELECT * FROM storage_logs WHERE storage_key = $1 ORDER BY logged_at DESC, id ASC',
      [storageKey],
    ),
  ]);

  const payload = buildPublicProfile(
    profile,
    workoutTypeResult.rows.map(mapWorkoutTypeRow),
    logResult.rows.map(mapLogRow),
    fallbackIdentifier ?? `id_${storageKey}`,
  );

  await pool.query(
    `
      INSERT INTO public_profile_cache (storage_key, source_revision, payload, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (storage_key)
      DO UPDATE SET source_revision = EXCLUDED.source_revision, payload = EXCLUDED.payload, updated_at = NOW()
    `,
    [storageKey, revision, JSON.stringify(payload)],
  );

  return payload;
}
