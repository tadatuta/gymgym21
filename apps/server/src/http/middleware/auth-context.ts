import type { RequestHandler } from 'express';
import { HttpError } from '../errors.js';
import type { AppDependencies } from '../app-types.js';

function toHeaders(source: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
      continue;
    }

    headers.set(key, value);
  }

  return headers;
}

export function createRequireAuthContext(dependencies: AppDependencies): RequestHandler {
  return async (req, _res, next) => {
    try {
      const authContext = await dependencies.resolveRequestContext(toHeaders(req.headers));

      if (!authContext) {
        throw new HttpError(401, 'Unauthorized');
      }

      req.authContext = authContext;
      next();
    } catch (error) {
      next(error);
    }
  };
}
