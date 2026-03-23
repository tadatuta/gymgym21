import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { generateRecommendation } from './ai.js';
import { createApp } from './app.js';
import { closeAuthResources, createAuthNodeHandler, ensureAuthReady, resolveRequestContext } from './auth.js';
import { config } from './config.js';
import { findPublicProfileByIdentifier } from './services/public-profile.js';
import { Storage } from './storage.js';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function startServer(): Promise<Server> {
  await Storage.ensureStorageDir();
  await ensureAuthReady();

  const app = createApp({
    authHandler: createAuthNodeHandler(),
    resolveRequestContext,
    generateRecommendation,
    findPublicProfile: findPublicProfileByIdentifier,
    readStorage: Storage.read.bind(Storage),
    writeStorage: Storage.write.bind(Storage),
  });

  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(config.PORT, config.HOST, resolve);
  });

  console.log(`Server listening on http://${config.HOST}:${config.PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}, shutting down...`);

    try {
      await closeServer(server);
      await closeAuthResources();
      process.exit(0);
    } catch (error) {
      console.error('Failed to shut down cleanly:', error);
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
