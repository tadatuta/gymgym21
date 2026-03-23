import { Router } from 'express';
import { HttpError } from '../errors.js';
import type { AppDependencies } from '../app-types.js';

export function createProfilesRouter(dependencies: AppDependencies): Router {
  const router = Router();

  router.get('/:identifier', async (req, res) => {
    const publicProfile = await dependencies.findPublicProfile(req.params.identifier);

    if (!publicProfile) {
      throw new HttpError(404, 'Not found');
    }

    res.json(publicProfile);
  });

  return router;
}
