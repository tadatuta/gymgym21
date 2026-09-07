import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  statusCode: number;
  code?: string;
  details?: unknown;

  constructor(statusCode: number, message: string, options?: { code?: string; details?: unknown }) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = options?.code;
    this.details = options?.details;
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not Found' });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request exceeds JSON_BODY_LIMIT; reduce the payload or adjust API and proxy limits', code: 'payload_too_large' });
    return;
  }

  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON request body', code: 'INVALID_JSON' });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'Invalid request body',
      code: 'INVALID_REQUEST',
      details: error.flatten(),
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
    return;
  }

  console.error('Unhandled request error:', error);
  res.status(500).json({ error: 'Internal Server Error' });
};
