import type { RequestHandler } from 'express';
import { writeLog } from '../db/mongo.js';
import { logger } from '../lib/logger.js';

export const requestLogger: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const entry = {
      type: 'request' as const,
      correlationId: req.correlationId,
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
      userId: req.user?.id
    };
    void writeLog(entry).catch((error) => logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'request log write failed'));
  });
  next();
};
