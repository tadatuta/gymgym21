import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import type { AppDependencies } from './http/app-types.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { createRequireAuthContext } from './http/middleware/auth-context.js';
import { corsMiddleware } from './http/middleware/cors.js';
import { createIpRateLimitKey, createRateLimitMiddleware } from './http/middleware/rate-limit.js';
import { createMeRouter } from './http/routes/me.js';
import { createProfilesRouter } from './http/routes/profiles.js';

function createAuthRouteHandler(dependencies: AppDependencies) {
  return (req: Request, res: Response, next: NextFunction) => {
    void dependencies.authHandler(req, res).catch(next);
  };
}

function matchesAuthSuffix(req: Request, suffix: string): boolean {
  return req.path === suffix || req.path.endsWith(suffix);
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const authStrictRateLimit = createRateLimitMiddleware({
    name: 'auth-strict',
    windowMs: config.RATE_LIMIT_AUTH_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_AUTH_MAX,
    keyGenerator: createIpRateLimitKey('auth-strict'),
  });
  const authUsernameCheckRateLimit = createRateLimitMiddleware({
    name: 'auth-username-check',
    windowMs: config.RATE_LIMIT_AUTH_USERNAME_CHECK_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_AUTH_USERNAME_CHECK_MAX,
    keyGenerator: createIpRateLimitKey('auth-username-check'),
  });

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(corsMiddleware);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const authRouteHandler = createAuthRouteHandler(dependencies);
  app.all('/api/auth', authRouteHandler);
  app.all('/api/auth/*splat', (req, res, next) => {
    if (matchesAuthSuffix(req, '/username/check')) {
      authUsernameCheckRateLimit(req, res, next);
      return;
    }

    if (
      matchesAuthSuffix(req, '/telegram/sign-in')
      || matchesAuthSuffix(req, '/telegram/link')
      || matchesAuthSuffix(req, '/register/email')
      || matchesAuthSuffix(req, '/migration/complete')
    ) {
      authStrictRateLimit(req, res, next);
      return;
    }

    next();
  }, authRouteHandler);

  app.use(express.json({ limit: config.JSON_BODY_LIMIT }));

  app.use('/api/profiles', createProfilesRouter(dependencies));
  app.use('/api/me', createRequireAuthContext(dependencies), createMeRouter(dependencies));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
