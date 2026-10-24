import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const correlationId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id')?.trim();
  req.correlationId = incoming && incoming.length <= 128 && /^[\w.:/-]+$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.correlationId);
  next();
};
