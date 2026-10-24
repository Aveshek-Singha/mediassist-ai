import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

export const notFound: RequestHandler = (_req, res) => res.status(404).json({ error: 'Not found.' });

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) return res.status(400).json({ error: 'Invalid request.', details: error.flatten() });
  logger.error({ errorType: error instanceof Error ? error.name : 'unknown', errorCode: typeof error?.code === 'string' ? error.code : undefined, correlationId: req.correlationId }, 'request failed');
  const status = Number(error?.statusCode ?? error?.status ?? 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({ error: status < 500 ? error.message : 'Something went wrong.', correlationId: req.correlationId });
};
