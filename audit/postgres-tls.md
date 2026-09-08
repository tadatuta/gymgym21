# PostgreSQL TLS

`DATABASE_SSL=true` verifies the certificate chain and the actual database hostname/IP.
With an empty `DATABASE_SSL_CA_FILE`, Node uses its default trusted roots. For a private
CA, set `DATABASE_SSL_CA_FILE` to a readable PEM certificate bundle supplied by the
DB operator. This bundle replaces the default roots for this connection. No TLS
failure triggers a plaintext or unverified fallback. A wrong hostname, expired or
untrusted certificate must be fixed at the endpoint or by supplying the correct CA.

`DATABASE_SSL=false` (also the unset/empty default for local PostgreSQL) explicitly
uses plaintext, even if `PGSSLMODE` is set. Only the exact values `true`, `false`, or
empty/unset are accepted. A CA file with TLS disabled is a configuration error.
`PGSSLMODE` does not control this application's database pool.

Migration from the previous insecure TLS setting: remove **all** `ssl`, `sslmode`,
`sslcert`, `sslkey`, `sslrootcert`, and `uselibpqcompat` query parameters from
`DATABASE_URL`, including empty or URL-encoded parameters. They are rejected before
pg parses the URL because they could override TLS settings or read files. Use only
`DATABASE_SSL` and `DATABASE_SSL_CA_FILE`. Unix socket URLs are not supported by this
URL-based configuration; TLS requires a TCP hostname/IP matching the certificate.
Client certificate authentication is not configured by these settings.

For native remote DB use, set the three variables in the server environment. For
Docker, supply certificates at runtime; never bake them into the image or put them
in the repository. The production image runs as `node`, so its UID must be able to
read the mounted file. `docker-compose.yml` passes `DATABASE_SSL_CA_FILE` through.
The default Compose PostgreSQL is plaintext; enabling TLS additionally requires a
TLS-configured PostgreSQL endpoint with a matching certificate. Compose's wrapper
always constructs the local `postgres:5432` URL; it does not select a remote DB from
`DATABASE_URL`. Use native deployment (or your own container configuration running
`node dist/server.js`) for a remote DB.

Example optional Compose override for a separately TLS-configured Compose PostgreSQL
whose certificate includes `DNS:postgres`:

```yaml
services:
  server:
    environment:
      DATABASE_SSL: "true"
      DATABASE_SSL_CA_FILE: /run/secrets/postgres-ca.pem
    volumes:
      - type: bind
        source: /absolute/operator-managed/postgres-ca.pem
        target: /run/secrets/postgres-ca.pem
        read_only: true
        bind:
          create_host_path: false
```

Unreadable and invalid CA errors name the setting and corrective action without
printing the path, URL, certificate, or credentials. CA loading occurs once when a
pool is created. After rotating the mounted CA bundle, restart the server to create
a new pool. Keep old/new CA overlap in the bundle during planned rotation.

Reproducible checks (Node 22, Docker and OpenSSL; local cached `postgres:16-alpine`
and current server runtime image):

```sh
npm run build --workspace @gym21/server
GYM21_TLS_RUNTIME_IMAGE=<current-server-image-id> node audit/postgres-tls.mjs
```

The fixture creates its own UUID-named PostgreSQL container, tmpfs data and synthetic
one-day CA/certificate (`DNS:localhost`), then removes its container and temporary
files in `finally`. It tests untrusted rejection, custom CA success, mismatched IP
rejection, explicit plaintext, hostile URL parameters, environment overrides, and
unreadable/invalid CA. A non-root Linux runtime connection loads a read-only mounted
CA and the freshly compiled TLS helper. It does not run migrations or access any
existing database. The ordinary server test suite runs the configuration tests;
the real TLS test requires the fixture environment and is otherwise skipped.
