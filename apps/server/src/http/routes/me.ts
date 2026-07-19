import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import type { AppDependencies } from '../app-types.js';
import { createRateLimitMiddleware, createStorageRateLimitKey } from '../middleware/rate-limit.js';

const syncMetadataSchema = {
  id: z.string(),
  updatedAt: z.string().optional(),
  isDeleted: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
  serverUpdatedAt: z.string().optional(),
};

const workoutTypeSyncSchema = z.object({
  ...syncMetadataSchema,
  name: z.string(),
  category: z.enum(['strength', 'time']).optional(),
  order: z.number().int().optional(),
}).strict();

const logSyncSchema = z.object({
  ...syncMetadataSchema,
  workoutTypeId: z.string(),
  workoutId: z.string().optional(),
  reps: z.number().optional(),
  weight: z.number().optional(),
  duration: z.number().optional(),
  durationSeconds: z.number().optional(),
  date: z.string(),
}).strict();

const workoutSyncSchema = z.object({
  ...syncMetadataSchema,
  startTime: z.string(),
  endTime: z.string().optional(),
  name: z.string().optional(),
  status: z.string(),
  isManual: z.boolean(),
  pauseIntervals: z.array(z.object({
    start: z.string(),
    end: z.string().optional(),
  }).strict()),
}).strict();

const profileSyncSchema = z.object({
  ...syncMetadataSchema,
  isPublic: z.boolean(),
  showFullHistory: z.boolean().optional(),
  displayName: z.string().optional(),
  username: z.string().optional(),
  telegramUsername: z.string().optional(),
  telegramUserId: z.number().int().optional(),
  photoUrl: z.string().optional(),
  createdAt: z.string(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  birthDate: z.string().optional(),
  height: z.number().optional(),
  weight: z.number().optional(),
  additionalInfo: z.string().optional(),
  friends: z.array(z.object({
    identifier: z.string(),
    displayName: z.string(),
    photoUrl: z.string().optional(),
    addedAt: z.string(),
  }).strict()).optional(),
}).strict();

const syncRequestSchema = z.object({
  cursor: z.number().int().nonnegative(),
  protocolVersion: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  batchId: z.string().min(1).max(100).optional(),
  changes: z.object({
    workoutTypes: z.array(workoutTypeSyncSchema).optional(),
    logs: z.array(logSyncSchema).optional(),
    workouts: z.array(workoutSyncSchema).optional(),
    profile: profileSyncSchema.nullish(),
  }).strict(),
}).strict();

const aiRequestSchema = z.object({
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
    const payload = syncRequestSchema.parse(req.body);
    res.json(await dependencies.storageRepository.sync(req.authContext!.storageKey, payload, req.authContext!));
  });

  router.post('/ai/recommendations', aiRateLimit, async (req, res) => {
    const payload = aiRequestSchema.parse(req.body);
    const userData = await dependencies.storageRepository.readAiContext(req.authContext!.storageKey);
    const recommendation = await dependencies.generateRecommendation({
      ...payload,
      profile: userData.profile,
      logs: userData.logs,
      workouts: userData.workouts,
      workoutTypes: userData.workoutTypes,
    });

    res.json({
      format: 'markdown',
      recommendation,
    });
  });

  return router;
}
