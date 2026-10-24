import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { adminOrigins, env } from './config/env.js';
import { apiRouter } from './modules/api/routes.js';
import { correlationId } from './middleware/correlationId.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { requestLogger } from './middleware/requestLogger.js';

export const app = express();
if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);
const widgetOrigins = env.NODE_ENV === 'production' ? [] : ['http://localhost:5174', 'http://127.0.0.1:5174'];
const allowedOrigins = new Set([...adminOrigins, ...widgetOrigins]);

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors((req, callback) => {
  const origin = req.header('origin');
  if (req.path === '/widget.js') return callback(null, { origin: '*' });
  if (!origin) return callback(null, { origin: false });
  if (req.path.startsWith('/public/')) return callback(null, { origin, exposedHeaders: ['X-Request-Id'] });
  if (allowedOrigins.has(origin)) return callback(null, { origin, credentials: true, exposedHeaders: ['X-Request-Id'] });
  return callback(null, { origin: false });
}));
app.use(express.json({ limit: env.JSON_BODY_LIMIT, verify: (req, _res, buffer) => { (req as express.Request).rawBody = buffer.toString('utf8'); } }));
app.use(correlationId);
app.use(requestLogger);
app.use(apiRouter);
app.use(notFound);
app.use(errorHandler);
