import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { adminOrigins, env } from '../config/env.js';
import { getRecord } from '../db/store.js';
import { collection, type User } from '../modules/models.js';

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const cookieToken = readCookie(req.header('cookie'), env.NODE_ENV === 'production' ? '__Host-mediassist_session' : 'mediassist_session');
  const token = authorization || cookieToken;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  if (!authorization && cookieToken && isUnsafeMethod(req.method)) {
    const origin = req.header('origin');
    if (!origin || !adminOrigins.includes(origin)) return res.status(403).json({ error: 'This browser request origin is not allowed.' });
  }
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'], issuer: 'mediassist-api', audience: 'mediassist-admin'
    }) as jwt.JwtPayload;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
  if (payload.purpose !== undefined && payload.purpose !== 'session') return res.status(401).json({ error: 'This token is not a workspace session.' });
  try {
    if (typeof payload.sub !== 'string') return res.status(401).json({ error: 'Invalid or expired session.' });
    const user = await getRecord<User>(collection.users, payload.sub);
    if (!user) return res.status(401).json({ error: 'Session is no longer valid.' });
    if (user.active === false) return res.status(401).json({ error: 'This account has been disabled.' });
    if (env.REQUIRE_ADMIN_MFA === 'true' && user.role === 'admin' && !user.mfaEnabled) return res.status(401).json({ error: 'Set up an authenticator app before continuing.' });
    if ((typeof payload.sessionVersion === 'number' ? payload.sessionVersion : 0) !== (user.sessionVersion ?? 0)) return res.status(401).json({ error: 'Session was revoked. Sign in again.' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  next();
};

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return undefined; }
  }
  return undefined;
}

function isUnsafeMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}
