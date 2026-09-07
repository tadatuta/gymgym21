# O01 — incremental IndexedDB cache and bounded workout reads

Baseline: `de0780b388a62653e3ad88912f7c5e065b454ec6` (S10). Measurements use real headless Google Chrome on this Mac, Node 22.23.2, synthetic accounts only. No production API, cookies, `.env`, or user records are used.

## Reproduction

From the repository root, set `PLAYWRIGHT_MODULE_PATH` to an installed Playwright `index.mjs` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to Google Chrome. Run:

```sh
node audit/cache-performance-browser.mjs --baseline
node audit/cache-performance-browser.mjs
node audit/cache-reconciliation-browser.mjs
node audit/sync-batching-browser.mjs
node audit/training-time-browser.mjs
```

`--baseline` serves tracked client source from the S10 commit through a Vite load hook; `O01_BASELINE_REF` can explicitly override that revision. Dependencies remain the installed S10-compatible dependencies. Both runs use the same synthetic fixtures and actual `StorageService` mutations plus the production workout page renderer. The Vite server has `configFile: false` and an empty temporary `envDir`; the browser context is disposable. An earlier attempt to serve an extracted temporary checkout failed module parsing and produced no measurements; it was replaced by the committed-source loader.

The fixture first creates 10,000 / 100,000 logs with distinct daily timestamps and a missing workout reference. It edits the newest log and renders the current week (seven visible original sets). It then installs one implicit finished session per day, associates each log with that session, reloads once outside measurement, adds an ordinary set to today's existing session, and renders again. The add assertion verifies reuse of that session rather than duplicate creation. Initial population/reconciliation and Vite startup are excluded.

Instrumentation counts **returned domain rows** from native `IDBObjectStore` and `IDBIndex` `get`, `getAll`, and `openCursor` successes; it excludes outbox/conflict/state rows, absent keys, and internal IndexedDB index traversal. It measures data materialized in JS, not physical disk I/O. CI assertions enforce bounded rows (edit ≤4, add ≤20), with no wall-clock thresholds.

## Results

Milliseconds, single samples; elapsed times are descriptive and sensitive to JIT, GC, and machine load.

| Fixture | Logs | Before mutation | After mutation | Before week render | After week render | Before domain rows | After domain rows |
|---|---:|---:|---:|---:|---:|---:|---:|
| Edit, missing session | 10,000 | 67.4 | 2.4 | 1,620.6 | 2.1 | 10,003 | 2 |
| Edit, missing session | 100,000 | 734.6 | 1.4 | 21,090.9 | 1.4 | 100,003 | 2 |
| Add, one implicit session/day | 10,000 | 1,157.1 | 6.1 | 1,514.7 | 1.4 | 30,006 | 9 |
| Add, one implicit session/day | 100,000 | 16,413.2 | 298.4 | 20,691.5 | 2.2 | 300,006 | 9 |

A subsequent after-only run recorded three consecutive add samples: **10k: 5.0 / 2.7 / 3.0ms; 100k: 17.3 / 10.5 / 10.3ms**. Returned domain rows were **9 / 10 / 11** at both sizes, growing only with the sets in today’s implicit session. This repeat is now part of the optimized benchmark; the baseline keeps one add sample. Active/paused workout lookup uses its own Map and never materializes the full session list.

The 100k add elapsed-time spike remains visible in the report; bounded row counts do not guarantee constant wall-clock latency. The process retains the full account cache and indexes, and population immediately precedes measurement. No GC or memory-isolation claim is made. The original pre-edit baseline (before adding the second fixture/index instrumentation) measured 90.5/711.4ms mutation and 1,455.4/20,658.8ms rendering at 10k/100k, with the same 10,003/100,003 domain row counts.

## Implementation and guarantees

- Each account owns committed entity/conflict ID journals. Local mutations and sync response application append only after their transaction commits. Sync's successful pull is recorded before an invalid-local-record/oversized-record error is raised. Transaction rollback and newer local generations retain their existing protections.
- Cache refreshes serialize and take only their captured journal batch. They read changed IDs with `bulkGet` in one read transaction, maintain record Maps, and compare canonical signatures per record. Only `version`, `serverUpdatedAt`, and `updatedAt` are excluded from domain notifications. Metadata still replaces cached records. Subscribers can inspect changed entity/conflict IDs.
- Failed incremental reads restore their batch; failed full reconciliations require a successful full retry before a later delta can be accepted. Activation, visibility, explicit reload, backup replacement and unknown/missed broadcast sequences reconcile fully.
- Outgoing committed IDs have a separate journal from cache reads, so an incoming refresh cannot consume another operation's notification. Broadcasts contain bounded IDs (≤2,000 total entity/conflict entries), sender identity and sequence, scoped to the account. Unknown senders, gaps and bulk updates reconcile fully. Account disposal closes the channel and guards in-flight reads and callbacks.
- Day buckets use one formatter for the stored owner zone. Zone changes rebuild the index. Weekly history, day sharing, entity editing, workout duration and renderer grouping avoid complete-history scans. The latest-set indexed max heap uses actual event instants and stable ID ties; updates/removals are logarithmic and invalid/deleted records cannot win. Full-history/statistics callers still receive all active records and independent arrays.
- Adding or moving a set uses the existing status/start-time indexes instead of reading every workout. The ISO date window is padded for timestamp offsets and owner time zones, followed by the exact owner-day predicate. Implicit-session ID selection is preserved. Non-ISO malformed dates are retained in storage/cache but are not candidates in this valid-date association query. No schema migration or additional persisted cache is introduced.
- Session-bound updates still read sets belonging to the affected implicit session. All-history views, initial hydration, owner-zone rebuilds, and large backup reconciliation remain proportional to account size. Sorted day-key insert/removal can shift an in-memory array. This change does not claim fully lazy storage or bounded memory for arbitrary history.

## Verification

- Full client suite: 197 tests; nine new cache/index regressions cover bounded reads and change composition, metadata refresh, tombstones, missing rows, zone/workout/day movement, orphan retention, array ownership, ISO offsets ±14h and session selection, read-failure recovery, rollback/account isolation, outgoing-drain race, conflict restore/dismiss, and latest-index agreement through 500 inserts plus 500 mixed edits/deletes/ties/invalid dates.
- Existing generation/rollback, invalid dirty record pulls, retry/cooldown, backup, training-day/DST, drafts and component-lifecycle regressions remain green. Client typecheck, ESLint and production build pass (511.18 kB JS / 157.70 kB gzip).
- Real Chrome cross-tab test: first unknown sender causes one full reconciliation; next mutation (including a forced earlier cache drain) causes zero full reads; switching the receiver account prevents updates and record leakage.
- Real Chrome 10,001-log sync: 21 accepted requests / 23 attempts including 503 and 429 Retry-After, largest body 66,564 bytes, outbox 0; all 10,001 cached records receive server versions, zero full cache reads, zero metadata-only UI updates.
- Real Chrome production training/edit flow: seconds/category changes, implicit-session moves/bounds, owner-zone rendering, expected outbox, unsaved main/settings/profile drafts and disposed controls pass.

Server and shared contracts are unchanged; the client pretest rebuilds contracts. PostgreSQL and production deployment were not rerun for this client-only change.
