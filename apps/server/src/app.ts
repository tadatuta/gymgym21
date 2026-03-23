import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import type { AppDependencies } from './http/app-types.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { createRequireAuthContext } from './http/middleware/auth-context.js';
import { corsMiddleware } from './http/middleware/cors.js';
import { createMeRouter } from './http/routes/me.js';
import { createProfilesRouter } from './http/routes/profiles.js';

function createAuthRouteHandler(dependencies: AppDependencies) {
  return (req: Request, res: Response, next: NextFunction) => {
    void dependencies.authHandler(req, res).catch(next);
  };
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(corsMiddleware);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const authRouteHandler = createAuthRouteHandler(dependencies);
  app.all('/api/auth', authRouteHandler);
  app.all('/api/auth/*splat', authRouteHandler);

  app.use(express.json({ limit: config.JSON_BODY_LIMIT }));

  app.use('/api/profiles', createProfilesRouter(dependencies));
  app.use('/api/me', createRequireAuthContext(dependencies), createMeRouter(dependencies));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
