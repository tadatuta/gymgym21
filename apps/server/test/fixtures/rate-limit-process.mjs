// Synthetic two-process HTTP fixture. Never calls an external auth/AI provider.
import { createServer } from 'node:http';
import { createApp } from '../../dist/app.js';
import { ensureDatabaseReady, closeDatabasePool } from '../../dist/database.js';
await ensureDatabaseReady();
let settle;
const app = createApp({
  authHandler: async (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); },
  resolveRequestContext: async () => ({ kind: 'better-auth', storageKey: 'shared-owner', authUser: { id: 'fixture' } }),
  storageRepository: { readAiContext: async () => ({ profile: {}, types: [], logs: [] }) },
  generateRecommendation: async () => new Promise(resolve => { settle = resolve; process.send({ operation: true }); }),
  findPublicProfile: async () => null,
});
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.send({ port: server.address().port });
process.on('message', async message => {
  if (message === 'settle') { settle?.('done'); process.send({ settled: true }); }
  if (message === 'stop') {
    settle?.('done');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await closeDatabasePool();
    process.exit(0);
  }
});
