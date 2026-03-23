import { Router } from 'express';
import { marked } from 'marked';
import { z } from 'zod';
import type { AppDependencies } from '../app-types.js';
import { prepareStorageDataForWrite } from '../../services/storage-data.js';

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

  router.get('/storage', async (req, res) => {
    res.json(await dependencies.readStorage(req.authContext!.storageKey));
  });

  router.put('/storage', async (req, res) => {
    const data = prepareStorageDataForWrite(req.body, req.authContext!);
    await dependencies.writeStorage(req.authContext!.storageKey, data);
    res.json({ success: true });
  });

  router.post('/ai/recommendations', async (req, res) => {
    const payload = aiRequestSchema.parse(req.body);
    const userData = await dependencies.readStorage(req.authContext!.storageKey);
    const recommendation = await dependencies.generateRecommendation({
      ...payload,
      profile: userData.profile,
      logs: userData.logs,
      workouts: userData.workouts,
      workoutTypes: userData.workoutTypes,
    });

    res.json({
      recommendation: await marked(recommendation),
    });
  });

  return router;
}
