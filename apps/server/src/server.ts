import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { generateRecommendation } from './ai.js';
import { createApp } from './app.js';
import { closeAuthResources, createAuthNodeHandler, ensureAuthReady, resolveRequestContext } from './auth.js';
import { config, HAS_DATABASE } from './config.js';
import { checkDatabaseReadiness, closeDatabasePool, ensureDatabaseReady } from './database.js';
import { rateLimitStoreReady } from './http/middleware/rate-limit.js';
import { defaultRateLimitStore } from './http/middleware/rate-limit-store.js';
import { findPublicProfileByIdentifier } from './services/public-profile.js';
import { defaultStorageRepository } from './storage.js';

function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
}

const shutdowns = new WeakMap<Server, () => Promise<void>>();

export async function stopServer(server: Server): Promise<void> {
  await shutdowns.get(server)?.();
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${phase} deadline exceeded`), { code: 'RUNTIME_TIMEOUT' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function startServer(): Promise<Server> {
  if (!HAS_DATABASE) {
    console.error('[server] DATABASE_URL is required for the PostgreSQL runtime', { code: 'DATABASE_URL_REQUIRED' });
    throw Object.assign(new Error('DATABASE_URL is required for the PostgreSQL runtime'), { code: 'DATABASE_URL_REQUIRED' });
  }
  const startupDeadline = Date.now() + config.STARTUP_TIMEOUT_MS;
  const listenController = new AbortController();
  let phase = 'database';
  let closing = false;
  let started = false;
  let cleanup: ReturnType<typeof setInterval> | undefined;
  let cleaning = false;
  const sockets = new Set<Socket>();
  const handlers = new Map<NodeJS.Signals, () => void>();
  let shutdownPromise: Promise<void> | undefined;
  let server: Server | undefined;
  const removeHandlers = () => {
    clearInterval(cleanup);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    removeHandlers();
    shutdownPromise = (async () => {
      const deadline = Date.now() + config.SHUTDOWN_TIMEOUT_MS;
      if (server?.listening) {
        const current = server;
        try {
          await withDeadline(new Promise<void>((resolve, reject) => {
            current.close(error => error ? reject(error) : resolve());
          }), Math.max(1, deadline - Date.now()), 'HTTP shutdown');
        } catch (error) {
          console.warn('[server] HTTP shutdown deadline; destroying sockets', { connections: sockets.size, code: safeErrorCode(error) });
          current.closeAllConnections();
          for (const socket of sockets) socket.destroy();
        }
      }
      listenController.abort();
      await closeDatabasePool(Math.max(1, deadline - Date.now()));
      await closeAuthResources();
      console.info('[server] shutdown complete');
    })();
    return shutdownPromise;
  };

  try {
    await withDeadline((async () => {
      await ensureDatabaseReady();
      if (closing) return;
      await ensureAuthReady();
    })(), config.STARTUP_TIMEOUT_MS, 'Database startup');
    if (closing) throw new Error('Startup cancelled');
    const app = createApp({
      authHandler: createAuthNodeHandler(), resolveRequestContext, generateRecommendation,
      findPublicProfile: findPublicProfileByIdentifier, storageRepository: defaultStorageRepository,
      isReady: async () => started && !closing && rateLimitStoreReady() && await checkDatabaseReadiness() && !closing && rateLimitStoreReady(),
    });
    server = createServer({
      requestTimeout: config.HTTP_REQUEST_TIMEOUT_MS,
      headersTimeout: Math.min(config.HTTP_HEADERS_TIMEOUT_MS, config.HTTP_REQUEST_TIMEOUT_MS),
      keepAliveTimeout: config.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    }, app);
    server.setTimeout(config.HTTP_IDLE_TIMEOUT_MS, socket => {
      console.warn('[server] HTTP idle timeout');
      socket.destroy();
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.once('close', () => { started = false; removeHandlers(); });
    const current = server;
    phase = 'listen';
    await withDeadline(new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { current.removeListener('listening', onListen); reject(error); };
      const onListen = () => {
        current.removeListener('error', onError);
        if (closing) { current.close(); reject(new Error('Startup cancelled')); return; }
        resolve();
      };
      current.once('error', onError);
      current.once('listening', onListen);
      current.listen({ port: config.PORT, host: config.HOST, signal: listenController.signal });
    }), Math.max(1, startupDeadline - Date.now()), 'HTTP listen');
    started = true;
    server.on('error', error => console.error('[server] HTTP server error', { code: safeErrorCode(error) }));
    shutdowns.set(server, shutdown);
    cleanup = setInterval(() => {
      if (cleaning || closing || !config.RATE_LIMITS_ENABLED) return;
      cleaning = true;
      void defaultRateLimitStore.cleanup().catch(() => console.warn('[rate-limit] cleanup unavailable')).finally(() => { cleaning = false; });
    }, 30_000);
    cleanup.unref();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        console.info('[server] shutdown requested', { signal });
        void shutdown().then(() => process.exit(0), () => { console.error('[server] shutdown failed'); process.exit(1); });
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    console.info('[server] listening', { host: config.HOST, port: (server.address() as { port: number }).port });
    return server;
  } catch (error) {
    console.error('[server] startup failed', { phase, code: safeErrorCode(error) });
    await shutdown();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await startServer(); }
  catch { process.exitCode = 1; }
}
