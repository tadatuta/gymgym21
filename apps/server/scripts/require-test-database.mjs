// Validate before building or importing a test: never fall back to DATABASE_URL.
const value = process.env.GYM21_TEST_DATABASE_URL;
let valid = false;
try {
    const url = new URL(value);
    valid = ['postgres:', 'postgresql:'].includes(url.protocol)
        && Boolean(url.hostname)
        && url.pathname.length > 1;
} catch {
    // Keep credentials and the supplied URL out of diagnostics.
}

if (!valid) {
    console.error('test:integration requires GYM21_TEST_DATABASE_URL: a PostgreSQL URL with an explicit host and database for a disposable test database. DATABASE_URL is never used as a fallback.');
    process.exitCode = 1;
} else {
    console.log('Running the server suite with required PostgreSQL integration. The separate TLS fixture requires GYM21_TLS_TEST_URL (see audit/postgres-tls.md).');
}
