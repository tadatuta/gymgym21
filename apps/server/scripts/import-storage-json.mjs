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
    if (!arg.startsWith('--')) {
      continue;
    }

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

function isStorageCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return (
    Array.isArray(value.workoutTypes)
    || Array.isArray(value.logs)
    || Array.isArray(value.workouts)
    || (value.profile && typeof value.profile === 'object' && !Array.isArray(value.profile))
  );
}

function summarizePrepared(prepared) {
  return {
    revision: prepared.revision,
    counts: {
      workoutTypes: prepared.workoutTypes.length,
      workouts: prepared.workouts.length,
      logs: prepared.logs.length,
      profile: prepared.profile ? 1 : 0,
    },
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function buildManifestMap(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object' || !entry.sourceKey) {
      continue;
    }
    map.set(String(entry.sourceKey), entry);
  }
  return map;
}

async function truncateStorageTables(storagePool) {
  await storagePool.query(`
    TRUNCATE TABLE
      public_profile_cache,
      public_profile_aliases,
      storage_logs,
      storage_workouts,
      storage_workout_types,
      storage_profiles,
      storage_roots
    RESTART IDENTITY CASCADE
  `);
}

const options = parseArgs(process.argv.slice(2));
const report = {
  startedAt: new Date().toISOString(),
  mode: options.apply ? 'apply' : 'dry-run',
  dir: options.dir,
  processed: [],
  skipped: [],
  failed: [],
};

const [
  { ensureDatabaseReady, getDatabasePool },
  { ensureAuthDatabaseSchema, getAuthPool },
  { defaultStorageRepository, prepareImportedSnapshot },
] = await Promise.all([
  import('../dist/database.js'),
  import('../dist/auth-meta.js'),
  import('../dist/storage.js'),
]);

await ensureDatabaseReady();
await ensureAuthDatabaseSchema();

const storagePool = getDatabasePool();
const authPool = getAuthPool();

if (options.apply && options.truncateStorage) {
  await truncateStorageTables(storagePool);
}

const manifestEntries = options.manifest ? await readJson(options.manifest) : [];
const manifestMap = buildManifestMap(Array.isArray(manifestEntries) ? manifestEntries : []);
const entries = await fs.readdir(options.dir, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) {
    continue;
  }

  const filePath = path.join(options.dir, entry.name);
  const sourceKey = path.basename(entry.name, '.json');
  const manifestEntry = manifestMap.get(sourceKey) ?? {};
  const storageKey = String(manifestEntry.storageKey ?? sourceKey);

  try {
    const json = await readJson(filePath);
    if (!isStorageCandidate(json)) {
      report.skipped.push({
        file: filePath,
        sourceKey,
        reason: 'not a storage snapshot',
      });
      continue;
    }

    const prepared = prepareImportedSnapshot(json);
    const summary = summarizePrepared(prepared);

    if (options.verbose) {
      console.log(`[import] ${sourceKey} -> ${storageKey}`, summary);
    }

    if (options.apply) {
      await defaultStorageRepository.replaceSnapshot(storageKey, json);

      if (manifestEntry.userId) {
        await authPool.query(
          `
            INSERT INTO user_storage_binding (user_id, storage_key, created_at, updated_at)
            VALUES ($1, $2, NOW(), NOW())
            ON CONFLICT (user_id)
            DO UPDATE SET storage_key = EXCLUDED.storage_key, updated_at = NOW()
          `,
          [String(manifestEntry.userId), storageKey],
        );
      }
    }

    report.processed.push({
      file: filePath,
      sourceKey,
      storageKey,
      userId: manifestEntry.userId ?? null,
      ...summary,
    });
  } catch (error) {
    const details = {
      file: filePath,
      sourceKey,
      storageKey,
      error: error instanceof Error ? error.message : String(error),
    };
    report.failed.push(details);

    if (!options.skipInvalid) {
      break;
    }
  }
}

report.finishedAt = new Date().toISOString();

if (options.report) {
  await fs.mkdir(path.dirname(options.report), { recursive: true });
  await fs.writeFile(options.report, JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));

if (report.failed.length > 0 && !options.skipInvalid) {
  process.exitCode = 1;
}
