# O04 Docker artifact verification

Run `node audit/docker-runtime.mjs` with Node 22 and Docker on PATH (`DOCKER_BINARY` can override it). The fixture copies tracked sources only, explicitly skips private paths before reading files, and never uses the checkout as a Docker context. Synthetic excluded files prove the effective `.dockerignore` in a separate COPY-all probe image. The server and client are then built and tested on a disposable private network with a new PostgreSQL database; no host ports or external application services are used.

Checks cover nonroot UID, absent application sources/tests/client/dev packages, resolvable production dependencies and compiled contracts workspace link, migration files and applied ledger, health, real registration and cookie-backed session, client SPA fallback, referenced assets, manifest and service worker. Cleanup removes only fixture containers/volumes/network/image tags/temp context.

The production dependency stage uses the unchanged npm lock and selected server/contracts workspaces, including nested workspace modules. `--omit=optional` also removes optional development peers that npm otherwise retains despite `--omit=dev` (Vite → tsx/esbuild); required runtime packages remain installed. Build stages keep optional platform packages. Application runtime copies are explicit. Client nginx configuration and port 80 are preserved. JSON context inputs are allowlisted; add genuinely needed build JSON to `.dockerignore` when introducing new assets/configuration.

Documentation consulted: [npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci), [Docker context ignore rules](https://docs.docker.com/build/concepts/context/#dockerignore-files).

## Execution environment accommodation

On this machine the Docker VM could pull images but HTTPS requests to registry.npmjs.org timed out, including with host networking. Normal `npm ci` build stages could not finish. The fixture supports `GYM21_DOCKER_NPM_CACHE=/path/to/package-only/_cacache`: after the context probe, it mounts that cache into temporary Dockerfiles and adds `--offline --no-audit` to their existing npm ci commands. All versions, lockfile integrity checks, workspace filters, build commands and final runtime layers are preserved. Production Dockerfiles are not modified by this option. Only use a package-only cache, never a directory containing credentials or npm configuration.

The verification run populated a fresh package-only cache from lockfile tarball integrity addresses, including every Linux ARM64 optional package needed by this Docker host. Cached package bytes were checked by npm's cacache; missing public tarballs were downloaded on the host and inserted with the lockfile integrity requirement. No `.npmrc` or application secrets were read. Two unused architecture tarballs (esbuild 0.28.2 FreeBSD ARM64 and Linux ARM32) failed integrity and were rejected; no integrity bypass or lockfile rewrite was used. The final Linux ARM64/universal set contained 695 verified lock entries. Other architectures were not tested.

## Results (2026-09-08, Linux ARM64 / Node 22.23.2)

Actual server/client builds and all fixture assertions passed, including real PostgreSQL registration and returned-cookie session. Docker image inspect `.Size`: server **69,273,095 bytes**, client **22,309,408 bytes**. These are Docker-reported image sizes, not an estimate of build-context size or a before/after percentage. No baseline image was measured. The offline package bind mount is absent from the final images.

`node audit/compose-config.mjs` also passed: preserved runtime settings, fixed upstream, private database/dev loopback, required secrets, encoded synthetic credentials. `git diff --check` and Node syntax validation passed. No deployment or user database was touched.
