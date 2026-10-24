import type { RequestHandler } from 'express';
import { findRecordByField } from '../db/store.js';
import { collection, type ApiKey } from '../modules/models.js';

export const requirePublicKey: RequestHandler = async (req, res, next) => {
  const key = req.header('x-api-key') ?? req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!key) return res.status(401).json({ error: 'A public booking key is required.' });
  void findRecordByField<ApiKey>(collection.apiKeys, 'publicKey', key).then((record) => {
    if (!record?.enabled) return res.status(401).json({ error: 'The booking key is invalid or disabled.' });
    const origin = req.header('origin');
    if (origin && !record.allowedOrigins.includes('*') && !record.allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'This site is not allowed to use the booking widget.' });
    }
    req.publicApiKey = key;
    next();
  }).catch(next);
};
