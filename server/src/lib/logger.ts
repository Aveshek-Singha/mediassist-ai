import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  redact: {
    paths: [
      'req.headers.authorization', 'headers.authorization', '**.authorization',
      '**.password', '**.passwordHash', '**.secret', '**.apiKey', '**.publicKey',
      'LLM_API_KEY', 'MEDIBOOK_SERVICE_KEY', 'MEDIBOOK_WEBHOOK_SECRET', 'JWT_SECRET', 'WEBHOOK_ENCRYPTION_KEY'
    ],
    censor: '[REDACTED]'
  }
});
