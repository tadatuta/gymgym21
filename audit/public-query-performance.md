# O02: bounded public and AI reads

The public repository now reads aggregate rows rather than returning every historical log and exercise to Node.js. Public statistics still cover all nondeleted logs, including logs referencing removed exercises. Favorite ties use frequency, latest instant, then the first log ID in the existing descending-time/ascending-ID order. Recent activity is the last 14 **active owner days**, not a 14-day date range.

Full history is available in 100-log keyset pages with only the exercise definitions used by that page. Two limited index-seeking branches handle equal timestamps and earlier timestamps; they merge at most 202 candidate rows, including on a deep page in a 100k-row timestamp tie. The opaque cursor contains a storage-scope digest, revision, exact PostgreSQL microsecond instant and ID. Shared ID/date validation rejects malformed cursors before SQL. Revision changes produce a visible refresh action that discards accumulated history; privacy is checked for every page. Six-month heatmap day keys are aggregated independently of pagination, with an explicit owner-midnight timestamp bound.

Authoritative auth aliases, storage alias fallback, root revision, profile privacy and payload/cache reads share one read-only repeatable-read snapshot. Cache format 2 rejects old unbounded payloads; cache day expiry tracks the owner's rolling heatmap window. Cache writes occur after releasing the read snapshot and cannot replace newer revisions; fallback display text is derived per request. The client caches only the first bounded page, merges subsequent pages in view state, and never substitutes the cached first page for a failed continuation. Guest and signed-in profiles mount the same page controls.

AI applies `AI_MAX_EXERCISE_COUNT` and `AI_MAX_RECENT_LOGS` in SQL, preserving its exact revision snapshot. Its unused workout-session query/context property was removed. Migration `005_bounded_reads.sql` adds partial live-row indexes `(storage_key, logged_at DESC, id ASC)` and `(storage_key, updated_at DESC, id ASC)` for the actual public/AI reads. No `start_time` index was added: the only candidate read was removed, so there is no measured query to justify it.

## Reproduction

Use Node 22, built server/contracts, and a disposable PostgreSQL 16 database. No `.env` is loaded. The script creates a unique schema, captures SQL and parameters from calls to the **production repository**, runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, and drops its schema in `finally`.

```sh
npm run build --workspace @gym21/server
GYM21_TEST_DATABASE_URL=postgres://... node audit/public-query-performance.mjs
```

The URL must designate a disposable database; the actual fixture URL is supplied outside this report. The script writes [public-query-explain.json](public-query-explain.json), including complete plans, SQL, synthetic parameters, PostgreSQL version and returned row counts. It seeds 100k live logs at the same instant and 100k exercise types, tests a page after ID 90000, then rewrites the logs to a single exercise and repeats to expose skew-sensitive favorite aggregation. It asserts a nonempty heatmap, the full historical volume and exact deep-page first ID. The baseline removes only the two new indexes in that disposable schema, retaining existing production indexes.

## Recorded plans, 8 September 2026

Milliseconds below are individual local samples, not CI thresholds or production latency estimates. Other verification processes were running on the host. Index plan shape and bounded returned rows are the relevant evidence; aggregates are still scans.

| Production query, 100k distinct exercise IDs | Before new indexes, ms | Indexed, ms | Returned SQL rows |
| --- | ---: | ---: | ---: |
| First public history page | 130.554 | 0.139 | 101 (100 + continuation check) |
| History page after 90000 equal-time rows | 10.097 | 0.259 | 101 |
| AI exercise catalog | 21.932 | 0.051 | 50 |
| AI recent logs | 21.693 | 0.030 | 40 |
| Historical summary/favorite | 203.696 | 266.410 | 1 |
| Recent active days | 72.877 | 87.408 | 1 active day in this fixture; limit 14 |
| Heatmap owner-day keys | 159.751 | 97.800 | 1 active day in this fixture; limit 200 |

First-page shared-hit blocks fall from 1475 to 2; deep-page hits from 1436 to 8. AI catalog hits fall from 1281 to 1 and recent logs from 1475 to 4. The favorite plan uses a hash join of grouped frequency/latest data, not an array of all IDs or a per-type correlated full scan. With all 100k logs on one exercise the indexed summary takes 126.268 ms and the deep page 0.526 ms. Heatmap and recent-day aggregation remain O(history rows in their relevant range), especially when all 100k logs fall within that range. The indexes do not claim to accelerate the all-history summary.

## Verification

- Real PostgreSQL regressions exercise 207 live logs over three pages; equal timestamps and microseconds; orphan/deleted exercise references; tombstones; zero weights/seconds; latest 14 active owner days; current-day timezone bounds and heatmap days beyond the first page.
- Invalid calendar/NUL/blank-ID cursors return 400, cross-storage cursors cannot continue another profile, revision changes return 409, hidden profiles return no history. A committed writer interleaved after snapshot establishment cannot mix profile/cache/data revisions or overwrite the newer cache. Existing authoritative alias/privacy integration tests remain enabled.
- AI returns only configured SQL counts and no unused workouts. HTTP IP limits return 429 with `Retry-After`; configuration is documented in `.env.example`, Compose and README. Rate-limit state remains per process until O05.
- Client tests cover first-page-only caching, failed continuation without cache substitution, 409 restart and late response disposal. Real isolated Chromium loads 100 then 101 logs, preserves an independent heatmap, handles 409 and restarts with one current log; existing guest no-IDB, 403/404/503, retry, login/back/reload and stale navigation cases pass.

An in-flight read can complete with its already established public snapshot if privacy changes concurrently; subsequent requests check the new privacy state. The local offline cache retains its explicit dated-copy behavior. Shared deployment rate-limit state and migration-runner coordination are separate O05/O03 items.
