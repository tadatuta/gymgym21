import { pathToFileURL } from 'node:url';

// Compose owns the database endpoint; encode credentials instead of interpolating a URL.
export function configureDockerEnvironment(env) {
  for (const key of ['POSTGRES_PASSWORD', 'BETTER_AUTH_SECRET']) {
    const value = env[key];
    if (!value || value.length < 32 || ['gym21', 'change-me'].includes(value)) {
      throw new Error(`${key} must be a unique secret of at least 32 characters`);
    }
  }
  const url = new URL('postgres://postgres:5432/');
  url.username = env.POSTGRES_USER || 'gym21';
  url.password = env.POSTGRES_PASSWORD;
  url.pathname = '/' + encodeURIComponent(env.POSTGRES_DB || 'gym21');
  env.DATABASE_URL = url.href;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    configureDockerEnvironment(process.env);
  } catch (error) {
    // Configuration errors name the field only, never the secret.
    console.error(error instanceof Error ? error.message : 'Server startup failed');
    process.exit(1);
  }
  const { startServer } = await import('./dist/server.js');
  await startServer();
}
