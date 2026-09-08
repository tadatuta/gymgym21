# O05 — Runtime readiness, deadlines and shared admission

Runtime uses PostgreSQL for every enabled rate limit. There is no missing-DB or store-error fallback to in-memory counters. `createMemoryRateLimitStore` is an explicit dependency for isolated HTTP fixtures. All replicas must use the same database/schema, policies and trusted proxy configuration. Apply migration `007_shared_rate_limits.sql` through the existing runner before readiness.

`GET /health` reports process liveness. `GET /ready` reports 200 only after startup/migrations and a successful bounded DB probe, outside shutdown, and while the default store has no uncertain operation lease. Failure is 503 `{ok:false}` with no database details. Probe checkouts arriving after timeout are destroyed, not leaked; parallel pool exhaustion remains bounded by connection timeout. Proxy forwards `/ready`; Compose server healthcheck uses it and proxy depends on server health. Compose does not provide ongoing load-balancer removal or automatic unhealthy restarts; configure those at the deployment layer.

| Setting | Default ms | Scope |
| --- | ---: | --- |
| `DB_CONNECT_TIMEOUT_MS` | 5000 | Connect and pool checkout queue |
| `DB_STATEMENT_TIMEOUT_MS` | 120000 | SQL execution and idle transaction budget |
| `DB_QUERY_TIMEOUT_MS` | 125000 | Client-side query wait; use above SQL budget |
| `DB_MIGRATION_TIMEOUT_MS` | 600000 | Migration SQL and advisory lock; separate from normal large-backup queries |
| `STARTUP_TIMEOUT_MS` | 610000 | Total database initialization and bind wait |
| `READINESS_TIMEOUT_MS` | 2000 | Whole probe, including checkout |
| `HTTP_HEADERS_TIMEOUT_MS` | 15000 | Receiving headers (capped at request timeout) |
| `HTTP_REQUEST_TIMEOUT_MS` | 30000 | Receiving full request; Node checks on its connection-check interval |
| `HTTP_IDLE_TIMEOUT_MS` | 130000 | Socket inactivity including stalled responses; socket destroyed |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | 5000 | Idle keepalive |
| `SHUTDOWN_TIMEOUT_MS` | 15000 | HTTP drain and pool cleanup share one deadline |
| `RATE_LIMIT_STORE_TIMEOUT_MS` | 2000 | Each store SQL/lock wait and client query; checkout uses DB connect budget |
| `RATE_LIMIT_LEASE_MS` | 60000 | Expiring expensive-operation lease; renew every quarter lifetime |

All values accept positive integers. Invalid/zero values use bounded defaults. Set lease duration comfortably above store checkout/transaction latency, event-loop delays and outage detection. The store timeout is per SQL, not an entire transaction; all statements and checkout waits are bounded. Configure downstream proxy deadlines consistently with large atomic backup/import operations. SQL timeout cancels statements on PostgreSQL; client query timeout alone does not promise server cancellation. Migration SQL restores the normal statement budget before returning its session.

Shutdown is idempotent via exported `stopServer(server)`; signal handlers delegate to it then exit. Ordinary library shutdown does not call `process.exit`. It removes its signal/cleanup handlers and stops listening; after deadline it destroys tracked HTTP sockets (including incomplete requests) and ends active PostgreSQL clients. New connections completing after forced pool close are ended too. Old migration completions cannot overwrite the readiness of a new pool. Leases retain their originating pool, so an old operation cannot recreate the pool after shutdown. Signal exit is the final process boundary for outstanding external operations; `stopServer` cannot force an uncooperative library promise to settle. Failed binds and delayed DNS completion are cleaned up, with safe phase/error-code logging. Idle DB errors are handled without printing database URLs or parameters.

## Shared counters and operation lifetimes

Admission uses a hashed policy/client key and an atomic UPSERT row lock. Under that lock it resets expired windows, counts live leases, increments accepted request count, and creates a UUID lease for concurrency-limited policies. Window rejection is `429 RATE_LIMIT_EXCEEDED` with `Retry-After` and rate headers; concurrency rejection is `503 ROUTE_BUSY`; unavailable admission is `503 RATE_LIMIT_UNAVAILABLE` with retry hint. Window-only auth policies do not create leases. All mutating auth routes, password signin/signup/recovery, Telegram/migration and GET passkey challenge endpoints are covered; username checks have their separate shared policy. Better Auth retains its own additional local controls.

Public reads, storage sync/backup and AI hold leases through their actual operation promises. HTTP finish, disconnect and AI timeout cannot release an operation still running. Renewal is serialized with release and continues after response completion. Failure destroys the response to trigger the AI disconnect abort and blocks new local admissions/readiness; successful renewal can recover ownership only before expiry. Once expired, a lease cannot be resurrected; the local process stays blocked until that operation settles. Cleanup runs every 30s, deletes at most 500 expired leases and 500 unused expired buckets per pass, uses indexes and `SKIP LOCKED`, and never overlaps itself per process. Admission also removes expired leases for its own bucket. Persistent overload creating more than 500 new keys/30s per replica can outpace maintenance; monitor table size and run the same bounded cleanup more often or increase deployment-level abuse filtering.

This is a crash-recoverable lease, not an absolute distributed lock on external AI compute. A process pause/network partition beyond lease expiry lets another replica admit work while an old provider operation may still run. We deliberately expire dead-process slots, fail closed on uncertainty locally, and document the tradeoff. Google SDK abort is client transport cancellation, not proof of provider compute/billing cancellation. PostgreSQL server time controls lease/window state; keep replica clocks synchronized for displayed `Retry-After` headers.

## Reproduction and operations

Use Node 22 and set `GYM21_TEST_DATABASE_URL` to disposable PostgreSQL 16 only:

```sh
npm run test --workspace @gym21/server
node audit/dev-runtime.mjs
node audit/compose-config.mjs
node audit/docker-runtime.mjs
```

`apps/server/test/runtime.test.js` creates and drops a UUID schema and local TCP proxy; it starts two child HTTP processes with synthetic auth/AI. It tests blocked SQL, exhausted checkout and late probe cleanup, forced active-pool cleanup and reopen, bind failure, delayed DNS after startup deadline, stalled HTTP shutdown/inactivity timeout, DB outage/recovery (ready503/health200/admission503), shared password window and ignored-abort AI lease renewal across processes, concurrent admission/cleanup, crash expiry/stale renewal, late-disconnect admission cleanup and fail-closed renewal/recovery. No real Telegram/Google calls or production DB access.

When readiness fails, inspect safe `[server]` phase/code, `[database]` migration/connection, and `[rate-limit]` policy/kind/client-digest events. Check DB connectivity, pool pressure, migration lock holders and SQL duration. For uncertain leases allow operations to settle or restore connectivity before expiry; restarting abandons local renewals and remaining leases expire. Do not manually delete live leases to clear a busy response. Inspect aggregate counts/old expiry rows in the two rate tables; no raw IP or storage key is stored. For slow backups increase SQL/query/HTTP deadlines coherently, while keeping a finite budget. Increasing startup/migration/shutdown budgets also requires adapting Compose health start period and stop grace.

Verified 2026-09-08 on Node 22.23.2: server **92/92** with real UUID-schema PostgreSQL (zero skips), client **200/200**, contracts **9/9**, all workspace typechecks, server strict unused checks, client ESLint and root production build (client JS 512.82 kB / gzip 158.24 kB). Source-watch dev lifecycle passed including missing-config diagnostics and no orphan processes; synthetic Compose checks include API readiness dependency and grace. Final Linux ARM64 Docker smoke passed readiness, all seven migrations, actual synthetic registration/cookie session, runtime dependencies/nonroot and client SPA/assets/service worker. Image sizes: server **69,277,447 bytes**, client **22,309,408 bytes**. Docker VM registry HTTPS remained unavailable, so the reproduction used the O04 integrity-verified public npm cache via a temporary fixture-only offline bind; production Dockerfiles and lockfile were unchanged. These checks do not measure production database latency or external provider cancellation.
