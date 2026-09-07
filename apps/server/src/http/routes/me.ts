import { Router } from 'express';
import { z } from 'zod';
import { backupDataSchema, workoutType, log, workout, profile, number, id } from '../../backup-validation.js';
import { HttpError } from '../errors.js';
import { config } from '../../config.js';
import type { AppDependencies } from '../app-types.js';
import { holdRateLimitUntil, createRateLimitMiddleware, createStorageRateLimitKey } from '../middleware/rate-limit.js';

const syncRequestSchema = z.object({
  cursor: number.int(),
  // Missing version remains supported for legacy clients until S09.
  protocolVersion: z.literal(1).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  batchId: id.refine((value) => value.length <= 100).optional(),
  changes: z.object({
    workoutTypes: z.array(workoutType.strict()).optional(),
    logs: z.array(log.strict()).optional(),
    workouts: z.array(workout.strict()).optional(),
    // Strip legacy identity fields rather than accepting them as authoritative.
    profile: profile.extend({ id: z.literal('me') }).nullish(),
  }).strict().superRefine((data, ctx) => {
    for (const key of ['workoutTypes', 'logs', 'workouts'] as const) {
      const seen = new Set<string>();
      data[key]?.forEach((item, index) => {
        if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'Duplicate ID' });
        seen.add(item.id);
      });
    }
  }),
}).strict();

const aiRequestSchema = z.object({
  expectedRevision: number.int(),
  type: z.enum(['general', 'plan']),
  options: z
    .object({
      period: z.enum(['day', 'week']).optional(),
      allowNewExercises: z.boolean().optional(),
    })
    .optional(),
}).strict();

export function createMeRouter(dependencies: AppDependencies): Router {
  const router = Router();
  const syncRateLimit = createRateLimitMiddleware({
    name: 'storage-sync',
    windowMs: config.RATE_LIMIT_SYNC_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_SYNC_MAX,
    maxConcurrent: config.RATE_LIMIT_SYNC_MAX_CONCURRENT,
    keyGenerator: createStorageRateLimitKey('storage-sync'),
  });
  const aiRateLimit = createRateLimitMiddleware({
    name: 'ai-recommendations',
    windowMs: config.RATE_LIMIT_AI_WINDOW_MS,
    maxRequests: config.RATE_LIMIT_AI_MAX,
    maxConcurrent: config.RATE_LIMIT_AI_MAX_CONCURRENT,
    keyGenerator: createStorageRateLimitKey('ai-recommendations'),
  });

  router.post('/storage/sync', syncRateLimit, async (req, res) => {
    if (req.body && req.body.protocolVersion !== undefined && req.body.protocolVersion !== 1) {
      throw new HttpError(409, 'Unsupported sync protocol version', { code: 'UNSUPPORTED_PROTOCOL' });
    }
    const payload = syncRequestSchema.parse(req.body);
    res.json(await dependencies.storageRepository.sync(req.authContext!.storageKey, payload, req.authContext!));
  });

  router.post('/storage/backup', syncRateLimit, async (req, res) => {
    const payload = z.object({
      mode: z.enum(['merge', 'replace']),
      expectedRevision: number.int(),
      data: backupDataSchema,
    }).strict().parse(req.body);
    // backupDataSchema strips all client-supplied trusted identity fields.
    const result = await dependencies.storageRepository.sync(req.authContext!.storageKey, {
      cursor: payload.expectedRevision, changes: payload.data,
    }, req.authContext!, payload);
    console.info('Backup import completed', { mode: payload.mode, revision: result.cursor });
    res.json(result);
  });

  router.post('/ai/recommendations', aiRateLimit, async (req, res) => {
    const payload = aiRequestSchema.parse(req.body);
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) controller.abort(new HttpError(499, 'AI client disconnected', { code: 'AI_CANCELLED' }));
    };
    res.once('close', disconnect);
    const timer = setTimeout(() => controller.abort(new HttpError(503, 'AI request timed out', {
      code: 'AI_TIMEOUT', details: { timeoutMs: config.AI_TIMEOUT_MS },
    })), config.AI_TIMEOUT_MS);
    let abortListener: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abortListener = () => {
        console.warn('[ai] request cancelled', { code: controller.signal.reason.code });
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const operation = (async () => {
      const userData = await dependencies.storageRepository.readAiContext(req.authContext!.storageKey, payload.expectedRevision);
      controller.signal.throwIfAborted();
      return dependencies.generateRecommendation({ ...payload, ...userData, profile: userData.profile }, controller.signal);
    })();
    // Keep the slot even when a transport ignores cancellation and the HTTP response ends.
    holdRateLimitUntil(res, operation);
    try {
      const recommendation = await Promise.race([operation, cancelled]);
      res.json({ format: 'markdown', recommendation });
    } finally {
      clearTimeout(timer);
      res.removeListener('close', disconnect);
      controller.signal.removeEventListener('abort', abortListener!);
    }
  });

  return router;
}
