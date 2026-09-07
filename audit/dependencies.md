# S10: dependency usage and security review

Reviewed 2026-09-08 (Europe/Moscow), against S09 `51773c93bd95217801315d53e904a1d470bb83fb`, using Node 22.23.2 / npm 10.9.8.

## Result and scope

The full npm registry audit went from **32 findings** (4 critical, 17 high, 8 moderate, 3 low) to **0** across production and development dependencies. Machine-readable registry responses are [before](dependencies-before.json) and [after](dependencies-after.json). This records advisories known at review time, not a guarantee against future vulnerabilities.

Removed unused client `zod` and `@types/w3c-image-capture`, server `rimraf`, and direct server `kysely` / `@better-auth/kysely-adapter`. Searches covered tracked source, tests, scripts and configuration. Client runtime contracts obtain Zod from `@gym21/contracts`, which declares it; server routes/auth/errors still import and declare Zod. Better Auth itself owns Kysely and its adapter. `@types/sortablejs` and `vite-plugin-pwa` moved to client devDependencies; Sortable remains runtime.

## Compatibility decisions

- Better Auth and Passkey are both exactly **1.6.30** in both workspaces. This is the patched 1.6 line; 1.7 adds account identity/issuer migration requirements and is outside this security cleanup. No application auth API or database schema change was needed.
- Root `@better-auth/core: 1.6.30` override aligns plugins/adapters with Better Auth. Their broad `^1.6.30` peer ranges otherwise selected core 1.7.3 alongside core 1.6.30. Update/remove this constraint together with a deliberately reviewed auth release upgrade.
- Root `kysely: ^0.28.17` override keeps the patched existing 0.28 line. Better Auth allows `^0.28.17 || ^0.29.0`; crossing to 0.29 is unnecessary here. Revisit with the next auth/adapter upgrade.
- Vite **6.4.3** is the smallest patched major after 5.4.21. It supports Node 22; current PWA 1.2.0 supports Vite 3–7 and Vitest 4.1.0 accepts 6/7/8. Root `vite: ^6.4.3` override consolidates build and tests on this compatible patched line and removes Vitest's separate vulnerable Vite 8 copy. Revisit alongside both Vite consumers. No SSR, Sass or custom environment plugin migration applies to this project; production browser target remains Vite 6's `modules` default.
- DOMPurify minimum is **3.4.15**, concurrently minimum **9.2.4**. Other updates target vulnerable transitive packages within their owners' allowed ranges. Workbox 7.4.1 brings its supported newer Rollup plugins/serializer dependencies; no `npm audit fix --force` or unrelated direct major upgrade was used.
- Compatible resolver/dedupe side effects retained after full verification: client `globals` 17.4.0 → 17.12.0 and shared/server Zod 4.3.6 → 4.5.4. Both satisfy existing declared ranges; shared boundary, import and sync validation tests pass. Other hoisting changes (for example Node types 22 replacing the root copy of 25) preserve workspace requirements.
- npm 10's `audit fix`/`dedupe` crashed inside Arborist (`Cannot read properties of null (reading edgesOut)`) on the workspace peer graph. Targeted npm updates handled most fixes; temporary **npm 11.19.1** (Node requirement `^20.17.0 || >=22.9.0`) finished deduplication and remaining patches while preserving the existing lockfile. It was installed under `/tmp`; project Node/npm tooling was not changed. Final install and verification use npm 10.9.8.

Documentation consulted through Context7: [Vite 6 migration](https://v6.vite.dev/guide/migration), [Vite 6 build target](https://v6.vite.dev/config/build-options), [Better Auth 1.7 upgrade guide](https://github.com/better-auth/better-auth/blob/main/docs/content/docs/guides/1-7-upgrade-guide.mdx). Exact dependency/peer/engine ranges were checked in npm registry manifests and installed 1.6.30 source; Context7's 1.6 query also returned 1.7 material, so it was not treated as evidence of a required 1.6 schema migration.

## Audited dependency versions

Versions include every installed copy; a removed package no longer occurs in the graph. Severity is the original report's aggregate severity, including transitive effects.

| Package | Severity before | Before | After |
| --- | --- | --- | --- |
| `@babel/core` | low | 7.29.0 | 7.29.7 |
| `@babel/plugin-transform-modules-systemjs` | high | 7.29.0 | 7.29.8 |
| `@better-auth/passkey` | moderate | 1.5.6 | 1.6.30 |
| `@humanfs/node` | moderate | 0.16.7 | 0.16.8 |
| `@protobufjs/utf8` | moderate | 1.1.0 | 1.1.2 |
| `@rollup/plugin-terser` | moderate | 0.4.4 | 1.0.0 |
| `@simplewebauthn/server` | low | 13.3.0 | 13.3.3 |
| `better-auth` | critical | 1.5.6 | 1.6.30 |
| `body-parser` | low | 2.2.2 | 2.3.0 |
| `brace-expansion` | high | 1.1.12, 2.0.2, 5.0.4 | 1.1.18, 2.1.4, 5.0.9 |
| `browserslist` | high | 4.28.1 | 4.28.9 |
| `concurrently` | critical | 9.2.1 | 9.2.4 |
| `defu` | high | 6.1.4 | 6.1.7 |
| `dompurify` | moderate | 3.4.0 | 3.4.15 |
| `esbuild` | moderate | 0.21.5, 0.28.2 | 0.25.12, 0.28.2 |
| `fast-uri` | high | 3.1.0 | 3.1.7 |
| `form-data` | high | 4.0.5 | 4.0.6 |
| `js-yaml` | high | 4.1.1 | 4.3.2 |
| `kysely` | high | 0.28.14 | 0.28.17 |
| `lodash` | high | 4.17.23 | removed |
| `nanoid` | high | 3.3.11 | 3.3.18 |
| `path-to-regexp` | high | 8.3.0 | 8.4.2 |
| `picomatch` | high | 2.3.1, 4.0.3 | 4.0.7 |
| `postcss` | high | 8.5.8 | 8.5.28 |
| `protobufjs` | critical | 7.5.4 | 7.6.6 |
| `qs` | moderate | 6.15.0 | 6.16.0 |
| `serialize-javascript` | high | 6.0.2 | 7.1.1 |
| `shell-quote` | critical | 1.8.3 | 1.9.0 |
| `undici` | high | 7.24.5 | 7.29.1 |
| `vite` | high | 5.4.21, 8.0.1 | 6.4.3 |
| `workbox-build` | moderate | 7.4.0 | 7.4.1 |
| `ws` | high | 8.20.0 | 8.21.3 |

## Verification

All commands used Node 22.23.2 and the normal npm 10.9.8 after resolution:

- `npm ci --no-audit --no-fund`: clean installation; `npm ls --all --json`: exit 0, no invalid/missing/extraneous dependencies. No Better Auth core 1.7 or Vite 8 copy remains.
- `npm audit --json`: 0 findings including dev dependencies.
- Root typecheck and production build; client ESLint. Client bundle **502.94 kB / gzip 154.95 kB**, up from 470.71 / 147.00 at S09. The build succeeds with Vite's 500 kB chunk-size advisory; splitting is separate performance work.
- Client **188/188**, shared contracts **9/9**, server **78/78**, no skips. Server tests use disposable UUID schemas in test PostgreSQL and real installed auth/AI SDKs. Added Passkey endpoint regression exercises existing SQL schema, authenticated credential listing and registration options/challenge, and unauthenticated rejection. It does not claim a physical authenticator registration/login ceremony.
- Real isolated Chromium: Telegram SDK exchange/cookie restore/migration/retry; guest public/private/missing/error, route races and authenticated activation; training date/duration/category, drafts/disposal; **10001 logs, 21 successful requests / 23 attempts (503 + 429), largest body 66564 bytes, outbox 0**.
- Public browser fixture now acknowledges the actual accepted bootstrap records, returning authoritative versions. The older fixture always returned `acknowledged: []`, correctly causing S09's client to retain pending writes forever. The scenario additionally asserts outbox 0 and at most 10 sync requests, preserving the network-idle and route-race checks.
- `audit/contracts-packaging.mjs`: a second clean **offline npm ci** in an isolated fixture; root/standalone builds, clean typecheck, focused client/shared tests, compiled server imports with shared TS source absent and Docker shared COPY structure checks.
- `audit/dev-runtime.mjs`: clean dist, root/workspace dev, env precedence, server/shared edit restarts, transform recovery, startup failure and Ctrl+C without orphan children. Fixture dependency links now represent npm's legitimate nested workspace dependencies as well as hoisted root packages; workspace contracts still resolve to fixture-owned source.

Browser/dev fixtures use synthetic configuration and fresh contexts; project secrets, user cookies/data and production databases were not read. Production Docker images, physical Passkey devices and real external AI credentials remain outside these checks.
