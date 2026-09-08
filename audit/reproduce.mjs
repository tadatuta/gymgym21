// Supported regression entry point; assertions expect correct behavior.
// Set GYM21_TEST_DATABASE_URL to include PostgreSQL tests; use reproduce-server.mjs for mandatory preflight.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync('npm', ['run', 'check'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
