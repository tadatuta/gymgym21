import type { PoolClient } from 'pg';
import { accountTimeZone } from '../training-time.js';
import { createHash } from 'node:crypto';
import { publicLogSchema, publicWorkoutTypeSchema, publicProfileSchema, timestamp, id } from '@gym21/contracts';
import { HttpError } from '../http/errors.js';
import { ensureDatabaseReady, getDatabasePool } from '../database.js';
import { AuthMetaService, ensureAuthDatabaseSchema } from '../auth-meta.js';
import type { StorageProfile, PublicProfileData } from './types.js';
import type { AliasRow, RootRow, StorageProfileRow, StorageWorkoutTypeRow, StorageLogRow } from './rows.js';
import { sanitizeStorageKey, normalizeAlias, toNumber } from './values.js';
import { mapProfileRow } from './row-mappers.js';

export async function refreshPublicAliases(client: PoolClient, storageKey: string, profile: StorageProfile | undefined) {
  const desired = new Map<string, { alias: string; type: string }>();
  desired.set(`id_${storageKey}`.toLowerCase(), { alias: `id_${storageKey}`, type: 'storage_id' });

  // The caller prepares the unified schema before acquiring its transaction client.
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

const PAGE_SIZE = 100;
type HistoryCursor = { scope: string; revision: number; at: string; id: string };
const cursorScope = (key: string) => createHash('sha256').update(`public-history:${key}`).digest('hex');
function decodeCursor(value?: string): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as HistoryCursor;
    if (!parsed || !/^[a-f0-9]{64}$/.test(parsed.scope) || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 ||
      !id.safeParse(parsed.id).success ||
      typeof parsed.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.at) || !timestamp.safeParse(parsed.at).success) throw new Error();
    return parsed;
  } catch { throw new HttpError(400, 'Invalid history cursor', { code: 'INVALID_HISTORY_CURSOR' }); }
}

export async function findPublicProfileByIdentifier(identifier: string, cursor?: string): Promise<PublicProfileData | null> {
  const normalized = normalizeAlias(identifier);
  if (!normalized) return null;
  return readPublicProfile(undefined, identifier, cursor, normalized);
}

export async function getPublicProfileByStorageKey(storageKey: string | number, fallbackIdentifier?: string, cursor?: string): Promise<PublicProfileData | null> {
  const key = sanitizeStorageKey(storageKey);
  return readPublicProfile(key, fallbackIdentifier ?? `id_${key}`, cursor);
}

async function readPublicProfile(key: string | undefined, fallback: string, cursorValue?: string, alias?: string): Promise<PublicProfileData | null> {
  const cursor = decodeCursor(cursorValue);
  await ensureDatabaseReady();
  await ensureAuthDatabaseSchema();
  const pool = getDatabasePool();
  const client = await pool.connect();
  let cacheWrite: { key: string; revision: number; payload: PublicProfileData } | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (alias) {
      const authoritative = await AuthMetaService.getAlias(alias, client);
      const aliases = await client.query<AliasRow>('SELECT storage_key FROM public_profile_aliases WHERE alias_lower = $1 LIMIT 1', [alias]);
      const publicKey = aliases.rows[0]?.storage_key;
      if (authoritative && (!authoritative.storageKey || (publicKey && publicKey !== authoritative.storageKey))) return null;
      key = authoritative?.storageKey ?? publicKey;
    }
    if (!key) return null;
    const root = await client.query<RootRow>('SELECT server_revision FROM storage_roots WHERE storage_key = $1 LIMIT 1', [key]);
    const profiles = await client.query<StorageProfileRow>('SELECT * FROM storage_profiles WHERE storage_key = $1 LIMIT 1', [key]);
    const profile = mapProfileRow(profiles.rows[0]);
    if (!profile || profile.isDeleted || !profile.isPublic) return null;
    const revision = toNumber(root.rows[0]?.server_revision);
    if (cursor && (cursor.scope !== cursorScope(key))) throw new HttpError(400, 'Invalid history cursor', { code: 'INVALID_HISTORY_CURSOR' });
    if (cursor && (!profile.showFullHistory || cursor.revision !== revision)) throw new HttpError(409, 'History changed; reload profile', { code: 'PUBLIC_HISTORY_STALE' });
    const identity = {
      displayName: profile.displayName || profile.username || profile.telegramUsername || fallback,
      identifier: profile.username || profile.telegramUsername || fallback,
    };
    // Cache expires on the owner's day boundary, including the moving heatmap window.
    const timeZone = accountTimeZone(profile.timeZone);
    const cache = await client.query<{ payload: PublicProfileData }>(`SELECT payload FROM public_profile_cache
      WHERE storage_key = $1 AND source_revision = $2 AND payload->>'readVersion' = '2'
      AND (updated_at AT TIME ZONE $3)::date = (CURRENT_TIMESTAMP AT TIME ZONE $3)::date`, [key, revision, timeZone]);
    let payload: PublicProfileData;
    if (cache.rows[0]) {
      payload = publicProfileSchema.parse(cache.rows[0].payload);
      if (!cursor) return { ...payload, ...identity };
    } else {
      payload = await readPublicSummary(client, key, profile, fallback);
    }
    if (profile.showFullHistory) Object.assign(payload, await readHistoryPage(client, key, revision, cursor));
    if (!cursor) cacheWrite = { key, revision, payload };
    return { ...payload, ...identity };
  } finally {
    await client.query('ROLLBACK');
    client.release();
    // Write outside the read-only snapshot; never replace a newer cache or a changed root.
    if (cacheWrite) {
      await pool.query(`INSERT INTO public_profile_cache (storage_key, source_revision, payload, updated_at)
        SELECT storage_key, server_revision, $3::jsonb, NOW() FROM storage_roots WHERE storage_key = $1 AND server_revision = $2
        ON CONFLICT (storage_key) DO UPDATE SET source_revision = EXCLUDED.source_revision, payload = EXCLUDED.payload, updated_at = NOW()
        WHERE public_profile_cache.source_revision <= EXCLUDED.source_revision`,
      [cacheWrite.key, cacheWrite.revision, JSON.stringify({ ...cacheWrite.payload, readVersion: 2 })]);
    }
  }
}

async function readPublicSummary(client: PoolClient, key: string, profile: StorageProfile, fallback: string): Promise<PublicProfileData> {
  const zone = accountTimeZone(profile.timeZone);
  const stats = await client.query<{ total_workouts: string; total_volume: number; last_date: Date | null; favorite: string | null }>(`
    SELECT COUNT(DISTINCT (logged_at AT TIME ZONE $2)::date) AS total_workouts,
      COALESCE(SUM(COALESCE(weight, 0) * COALESCE(reps, 0)), 0) AS total_volume, MAX(logged_at) AS last_date,
      (SELECT name FROM storage_workout_types WHERE storage_key = $1 AND NOT is_deleted AND id = (
        SELECT counts.workout_type_id FROM (
          SELECT workout_type_id, COUNT(*) AS frequency, MAX(logged_at) AS latest
          FROM storage_logs WHERE storage_key = $1 AND NOT is_deleted GROUP BY workout_type_id
        ) counts JOIN storage_logs first ON first.storage_key = $1 AND NOT first.is_deleted
          AND first.workout_type_id = counts.workout_type_id AND first.logged_at = counts.latest
        ORDER BY frequency DESC, latest DESC, first.id ASC LIMIT 1)) AS favorite
    FROM storage_logs WHERE storage_key = $1 AND NOT is_deleted`, [key, zone]);
  const recent = await client.query<{ date: string; count: string }>(`SELECT to_char(logged_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date, COUNT(*) AS count
    FROM storage_logs WHERE storage_key = $1 AND NOT is_deleted GROUP BY date ORDER BY date DESC LIMIT 14`, [key, zone]);
  const result = stats.rows[0]!;
  const payload: PublicProfileData = {
    timeZone: zone, displayName: profile.displayName || profile.username || profile.telegramUsername || fallback,
    identifier: profile.username || profile.telegramUsername || fallback, photoUrl: profile.photoUrl,
    stats: { totalWorkouts: Number(result.total_workouts), totalVolume: result.total_volume,
      favoriteExercise: result.favorite ?? undefined, lastWorkoutDate: result.last_date?.toISOString() },
    recentActivity: recent.rows.reverse().map(row => ({ date: row.date, exerciseCount: Number(row.count) })),
  };
  if (profile.showFullHistory) {
    // Seven extra days cover the heatmap's Sunday alignment and JS month rollover.
    const days = await client.query<{ date: string }>(`SELECT DISTINCT to_char(logged_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date
      FROM storage_logs WHERE storage_key = $1 AND NOT is_deleted
      AND logged_at >= (((CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '6 months 7 days') AT TIME ZONE $2)
      AND logged_at < (((CURRENT_TIMESTAMP AT TIME ZONE $2)::date + 1)::timestamp AT TIME ZONE $2) ORDER BY date LIMIT 200`, [key, zone]);
    payload.activityDays = days.rows.map(row => row.date);
  }
  return payload;
}

async function readHistoryPage(client: PoolClient, key: string, revision: number, cursor?: HistoryCursor): Promise<Pick<PublicProfileData, 'logs' | 'workoutTypes' | 'history'>> {
  const fields = `id, workout_type_id, workout_id, reps, weight, duration, duration_seconds, logged_at,
    to_char(logged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
  // Each branch can seek through the mixed-direction index, including a very large timestamp tie.
  const query = cursor ? `SELECT * FROM (
    (SELECT ${fields} FROM storage_logs WHERE storage_key = $1 AND NOT is_deleted
      AND logged_at = $2::timestamptz AND id > $3 ORDER BY logged_at DESC, id ASC LIMIT ${PAGE_SIZE + 1})
    UNION ALL
    (SELECT ${fields} FROM storage_logs WHERE storage_key = $1 AND NOT is_deleted
      AND logged_at < $2::timestamptz ORDER BY logged_at DESC, id ASC LIMIT ${PAGE_SIZE + 1})
    ) page ORDER BY logged_at DESC, id ASC LIMIT ${PAGE_SIZE + 1}` :
    `SELECT ${fields} FROM storage_logs WHERE storage_key = $1 AND NOT is_deleted ORDER BY logged_at DESC, id ASC LIMIT ${PAGE_SIZE + 1}`;
  const logs = await client.query<StorageLogRow & { cursor_at: string }>(query, cursor ? [key, cursor.at, cursor.id] : [key]);
  const rows = logs.rows.slice(0, PAGE_SIZE);
  const types = await client.query<StorageWorkoutTypeRow>(`SELECT id, name, category FROM storage_workout_types
    WHERE storage_key = $1 AND NOT is_deleted AND id = ANY($2::text[]) ORDER BY id`, [key, [...new Set(rows.map(row => row.workout_type_id))]]);
  const last = rows.at(-1);
  return {
    logs: rows.map(row => publicLogSchema.parse({ id: row.id, workoutTypeId: row.workout_type_id,
      workoutId: row.workout_id ?? undefined, reps: row.reps ?? undefined, weight: row.weight ?? undefined,
      duration: row.duration ?? undefined, durationSeconds: row.duration_seconds ?? undefined, date: new Date(row.logged_at).toISOString() })),
    workoutTypes: types.rows.map(row => publicWorkoutTypeSchema.parse({ ...row, category: row.category ?? undefined })),
    history: { nextCursor: logs.rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ scope: cursorScope(key), revision, at: last.cursor_at, id: last.id })).toString('base64url') : null },
  };
}
