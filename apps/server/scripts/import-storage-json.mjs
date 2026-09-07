#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const flags = {
    dryRun: false,
    apply: false,
    skipInvalid: false,
    truncateStorage: false,
    verbose: false,
  };
  const values = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);

    switch (arg) {
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--apply':
        flags.apply = true;
        break;
      case '--skip-invalid':
        flags.skipInvalid = true;
        break;
      case '--truncate-storage':
        flags.truncateStorage = true;
        break;
      case '--verbose':
        flags.verbose = true;
        break;
      case '--dir':
      case '--manifest':
      case '--report':
        if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`);
        values[arg.slice(2)] = argv[index + 1];
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!values.dir) {
    throw new Error('--dir <path> is required');
  }

  if (flags.apply === flags.dryRun) {
    throw new Error('Choose exactly one mode: --dry-run or --apply');
  }

  return {
    ...flags,
    dir: path.resolve(values.dir),
    manifest: values.manifest ? path.resolve(values.manifest) : null,
    report: values.report ? path.resolve(values.report) : null,
  };
}

function key(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

// Validate supplied values before legacy defaults or timestamp normalization can hide errors.
function validateSnapshot(input, schema) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !['workoutTypes', 'workouts', 'logs', 'profile'].some((field) => field in input)) {
    throw new Error('Not a storage snapshot');
  }
  const normalized = { ...input };
  for (const field of ['workoutTypes', 'workouts', 'logs']) normalized[field] ??= [];
  // Null arrays are malformed, whereas omitted arrays are supported legacy snapshots.
  for (const field of ['workoutTypes', 'workouts', 'logs']) {
    if (input[field] === null) throw new Error(`${field} must be an array`);
  }
  if (Array.isArray(normalized.workouts)) normalized.workouts = normalized.workouts.map((item) => ({
    ...item, isManual: item?.isManual === undefined ? false : item.isManual,
    pauseIntervals: item?.pauseIntervals === undefined ? [] : item.pauseIntervals,
  }));
  if (normalized.profile === null) delete normalized.profile;
  if (normalized.profile && typeof normalized.profile === 'object' && !Array.isArray(normalized.profile)) {
    normalized.profile = { id: 'me', isPublic: false, createdAt: new Date().toISOString(), ...normalized.profile };
    for (const field of ['username', 'telegramUsername']) {
      const value = normalized.profile[field];
      if (value !== undefined && (typeof value !== 'string' || !/^@?[a-zA-Z0-9_]{1,200}$/.test(value))) {
        throw new Error(`Invalid profile.${field}`);
      }
    }
    const telegramId = normalized.profile.telegramUserId;
    if (telegramId !== undefined && (!Number.isSafeInteger(telegramId) || telegramId <= 0)) throw new Error('Invalid profile.telegramUserId');
  }
  const validated = schema.parse(normalized);
  if (validated.profile) {
    for (const field of ['username', 'telegramUsername', 'telegramUserId']) {
      if (normalized.profile[field] !== undefined) validated.profile[field] = normalized.profile[field];
    }
  }
  return validated;
}

// Resolve existing symlink ancestors even when a new report directory does not exist yet.
async function realTarget(target) {
  try { return await fs.realpath(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await realTarget(parent), path.basename(target));
  }
}

const report = { startedAt: new Date().toISOString(), status: 'validating', processed: [], planned: [], skipped: [], failed: [] };
let options;
let reportAllowed = false;
let database;
let auth;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.report) {
    const target = await realTarget(options.report);
    const sourceDir = await realTarget(options.dir);
    const relative = path.relative(sourceDir, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      || (options.manifest && target === await realTarget(options.manifest))) {
      throw new Error('--report must be outside the input directory and must not overwrite the manifest');
    }
    reportAllowed = true;
  }
  Object.assign(report, { mode: options.apply ? 'apply' : 'dry-run', dir: options.dir });
  const manifest = options.manifest ? await readJson(options.manifest) : [];
  if (!Array.isArray(manifest)) throw new Error('Manifest must be an array');
  const manifestMap = new Map();
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid manifest entry');
    key(entry.sourceKey, 'sourceKey');
    if (manifestMap.has(entry.sourceKey)) throw new Error(`Duplicate manifest source: ${entry.sourceKey}`);
    if (entry.storageKey !== undefined) key(entry.storageKey, 'storageKey');
    if (entry.userId !== undefined && (typeof entry.userId !== 'string' || !entry.userId.trim() || entry.userId.includes('\0'))) throw new Error('Invalid userId');
    manifestMap.set(entry.sourceKey, entry);
  }
  const entries = (await fs.readdir(options.dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .filter((entry) => path.join(options.dir, entry.name) !== options.manifest)
    .sort((a, b) => a.name.localeCompare(b.name));
  const sources = new Set(entries.map((entry) => path.basename(entry.name, '.json')));
  for (const source of manifestMap.keys()) if (!sources.has(source)) throw new Error(`Manifest source file missing: ${source}`);
  const { backupDataSchema } = await import('../dist/backup-validation.js');
  const { prepareImportedSnapshot, replaceSnapshotTx } = await import('../dist/storage.js');
  const plan = [];
  const destinations = new Set();
  const users = new Set();
  // Mapping ambiguity is always fatal, including --skip-invalid.
  for (const entry of entries) {
    const sourceKey = key(path.basename(entry.name, '.json'), 'sourceKey');
    const mapping = manifestMap.get(sourceKey) ?? {};
    const storageKey = key(mapping.storageKey ?? sourceKey, 'storageKey');
    if (destinations.has(storageKey)) throw new Error(`Duplicate destination: ${storageKey}`);
    destinations.add(storageKey);
    if (mapping.userId && users.has(mapping.userId)) throw new Error(`Duplicate userId: ${mapping.userId}`);
    if (mapping.userId) users.add(mapping.userId);
    try {
      const data = validateSnapshot(await readJson(path.join(options.dir, entry.name)), backupDataSchema);
      const prepared = prepareImportedSnapshot(data);
      plan.push({ sourceKey, storageKey, userId: mapping.userId, data });
      report.planned.push({ sourceKey, storageKey, userId: mapping.userId ?? null,
        counts: { workoutTypes: prepared.workoutTypes.length, workouts: prepared.workouts.length,
          logs: prepared.logs.length, profile: prepared.profile ? 1 : 0 } });
    } catch (error) {
      report.failed.push({ sourceKey, error: error.message });
    }
  }
  if (report.failed.length && (!options.skipInvalid || options.truncateStorage)) throw new Error('Invalid sources; import cancelled before database access');
  report.skipped = [...report.failed];
  if (!plan.length) throw new Error('No valid snapshots to import');
  if (options.verbose) console.error(`[import] validated ${plan.length} snapshots; skipped ${report.skipped.length}`);
  if (options.dryRun) {
    report.status = 'validated';
    report.databasePreflight = 'not performed; ownership and existing-root coverage checked during apply';
  } else {
    database = await import('../dist/database.js');
    auth = await import('../dist/auth-meta.js');
    await database.ensureDatabaseReady();
    await auth.ensureAuthDatabaseSchema();
    const client = await database.getDatabasePool().connect();
    let commitAttempted = false;
    try {
      await client.query('BEGIN');
      // Administrative import freezes ownership and root writers during validation + commit.
      await client.query('LOCK TABLE storage_roots, user_storage_binding, user_alias, public_profile_aliases IN EXCLUSIVE MODE');
      const roots = await client.query('SELECT storage_key FROM storage_roots');
      if (options.truncateStorage && roots.rows.some((row) => !destinations.has(row.storage_key))) {
        throw new Error('--truncate-storage requires a valid replacement for every existing storage root');
      }
      const bindings = (await client.query('SELECT user_id, storage_key FROM user_storage_binding')).rows;
      const aliases = (await client.query('SELECT user_id, alias_lower FROM user_alias')).rows;
      const publicAliases = (await client.query('SELECT alias_lower, storage_key FROM public_profile_aliases')).rows;
      const desiredAliases = new Map();
      for (const item of plan) {
        const bound = bindings.find((row) => row.storage_key === item.storageKey);
        if (item.userId) {
          if (!(await client.query('SELECT 1 FROM "user" WHERE id = $1', [item.userId])).rowCount) throw new Error(`Unknown userId: ${item.userId}`);
          if (bound && bound.user_id !== item.userId) throw new Error(`Storage already bound: ${item.storageKey}`);
          if (bindings.some((row) => row.user_id === item.userId && row.storage_key !== item.storageKey)) throw new Error(`User already bound elsewhere: ${item.userId}`);
        }
        const owner = item.userId ?? bound?.user_id;
        const requested = [`id_${item.storageKey}`];
        if (item.data.profile && !item.data.profile.isDeleted) {
          if (owner) requested.push(...aliases.filter((row) => row.user_id === owner).map((row) => row.alias_lower));
          else requested.push(...[item.data.profile.username, item.data.profile.telegramUsername].filter(Boolean));
        }
        for (const alias of requested.map((value) => value.replace(/^@/, '').toLowerCase())) {
          if ((desiredAliases.has(alias) && desiredAliases.get(alias) !== item.storageKey)
            || aliases.some((row) => row.alias_lower === alias && row.user_id !== owner)
            || publicAliases.some((row) => row.alias_lower === alias && row.storage_key !== item.storageKey)) {
            throw new Error(`Alias collision: ${alias}`);
          }
          desiredAliases.set(alias, item.storageKey);
        }
      }
      report.status = 'applying';
      const completed = [];
      for (const item of plan) {
        if (item.userId) await client.query(`INSERT INTO user_storage_binding (user_id, storage_key)
          VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [item.userId, item.storageKey]);
        const revision = await replaceSnapshotTx(client, item.storageKey, item.data);
        completed.push({ ...report.planned.find((row) => row.sourceKey === item.sourceKey), revision });
      }
      commitAttempted = true;
      await client.query('COMMIT');
      report.processed = completed;
      report.status = 'committed';
    } catch (error) {
      try { await client.query('ROLLBACK'); report.status = commitAttempted ? 'commit-unconfirmed' : 'rolled-back'; }
      catch (rollbackError) { report.status = 'rollback-unconfirmed'; report.failed.push({ error: `Rollback failed: ${rollbackError.message}` }); }
      throw error;
    } finally { client.release(); }
  }
} catch (error) {
  report.failed.push({ error: error instanceof Error ? error.message : String(error) });
  if (!['rolled-back', 'rollback-unconfirmed', 'commit-unconfirmed'].includes(report.status)) report.status = 'failed';
  process.exitCode = 1;
} finally {
  const results = await Promise.allSettled([database?.closeDatabasePool(), auth?.closeAuthPool()]);
  for (const result of results) if (result.status === 'rejected') {
    report.failed.push({ error: `Pool cleanup failed: ${result.reason}` }); process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  if (options?.report && reportAllowed) {
    try {
      await fs.mkdir(path.dirname(options.report), { recursive: true });
      await fs.writeFile(options.report, JSON.stringify(report, null, 2));
    } catch (error) { report.failed.push({ error: `Report write failed: ${error.message}` }); process.exitCode = 1; }
  }
  console.log(JSON.stringify(report, null, 2));
}
