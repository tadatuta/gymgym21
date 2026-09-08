import { Router } from 'express';
import { config } from '../../config.js';
import { createRateLimitMiddleware, createIpRateLimitKey, holdRateLimitUntil } from '../middleware/rate-limit.js';
import { HttpError } from '../errors.js';
import type { AppDependencies } from '../app-types.js';

export function createProfilesRouter(dependencies: AppDependencies): Router {
  const router = Router();

  router.use(createRateLimitMiddleware({ name: 'public-profile', windowMs: config.RATE_LIMIT_PUBLIC_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_PUBLIC_MAX, maxConcurrent: config.RATE_LIMIT_PUBLIC_MAX_CONCURRENT, keyGenerator: createIpRateLimitKey('public-profile') }, dependencies.rateLimitStore));
  router.get('/:identifier', async (req, res) => {
    if (req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' || !req.query.cursor || req.query.cursor.length > 2048)) {
      throw new HttpError(400, 'Invalid history cursor', { code: 'INVALID_HISTORY_CURSOR' });
    }
    const operation = dependencies.findPublicProfile(req.params.identifier, req.query.cursor as string | undefined);
    holdRateLimitUntil(res, operation);
    const publicProfile = await operation;

    if (!publicProfile) {
      throw new HttpError(404, 'Not found');
    }

    res.json(publicProfile);
  });

  return router;
}
