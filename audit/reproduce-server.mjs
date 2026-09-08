// Supported regression entry point; assertions expect correct behavior.
// The integration command requires a disposable GYM21_TEST_DATABASE_URL before build/import.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync('npm', ['run', 'test:integration'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
