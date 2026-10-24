import type { Request, RequestHandler } from 'express';
import { incrementRateLimitCounter } from '../db/store.js';

type RateLimitOptions = {
  windowMs: number;
  limit: number;
  prefix: string;
  key?: (request: Request) => string;
};

export function rateLimit(options: RateLimitOptions): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const identity = options.key?.(req) ?? req.ip ?? 'unknown';
    const windowStart = Math.floor(now / options.windowMs) * options.windowMs;
    void incrementRateLimitCounter(`${options.prefix}:${identity}`, options.windowMs, now)
      .then((count) => {
        const remaining = Math.max(0, options.limit - count);
        const resetSeconds = Math.max(0, Math.ceil((windowStart + options.windowMs - now) / 1000));
        res.setHeader('RateLimit-Limit', options.limit);
        res.setHeader('RateLimit-Remaining', remaining);
        res.setHeader('RateLimit-Reset', resetSeconds);
        if (count > options.limit) {
          res.setHeader('Retry-After', resetSeconds);
          return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        next();
      })
      .catch(() => res.status(503).json({ error: 'Request protection is temporarily unavailable.' }));
  };
}
