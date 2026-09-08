// Sequential, fail-fast portable browser suite. Every child owns its resources;
// a deadline or signal terminates its process group, including browser children.
import { spawn } from 'node:child_process';
import '../apps/server/scripts/require-test-database.mjs';
if (process.exitCode) throw new Error('Browser suite stopped: PostgreSQL preflight failed.');
const suites = ['auth-logout-browser.mjs', 'pwa-browser.mjs', 'training-time-browser.mjs', 'component-lifecycle-browser.mjs', 'cache-reconciliation-browser.mjs', 'sync-indicator-browser.mjs', 'public-guest-browser.mjs'];
for (const suite of suites) {
  console.log(`Browser suite: ${suite}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`audit/${suite}`], { stdio: 'inherit', detached: process.platform !== 'win32', env: process.env });
    let failure;
    let killTimeout;
    const terminate = reason => {
      if (failure) return;
      failure = new Error(reason);
      killTimeout = setTimeout(() => {
        try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }, 3000);
      try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    };
    const interrupted = signal => terminate(`Browser suite interrupted: ${signal}`);
    const sigint = () => interrupted('SIGINT'); const sigterm = () => interrupted('SIGTERM');
    process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
    const timeout = setTimeout(() => terminate(`${suite} exceeded 240 seconds`), 240000);
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timeout); clearTimeout(killTimeout);
      // The parent may exit on TERM before a stubborn browser descendant does.
      if ((failure || code !== 0) && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group already exited. */ }
      }
      process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
      if (failure || code !== 0) reject(failure || new Error(`${suite} exited ${code}`)); else resolve();
    });
  });
}
console.log(`Browser suite passed: ${suites.length} fixtures.`);
