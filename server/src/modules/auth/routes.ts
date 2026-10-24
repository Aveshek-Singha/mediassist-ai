import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { adminOrigins, env } from '../../config/env.js';
import { consumeUserRecoveryCode, findRecordByField, getRecord, insertRecordIfUniqueField, updateUserRecord } from '../../db/store.js';
import { asyncRoute } from '../../lib/asyncRoute.js';
import { decryptMfaSecret, encryptMfaSecret } from '../../lib/secrets.js';
import { createRecoveryCodes, createTotpSecret, createTotpUri, verifyTotp } from '../../lib/totp.js';
import { readCookie, requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { collection, type User } from '../models.js';

export const authRouter = Router();
const loginLimiter = rateLimit({ prefix: 'auth-login', windowMs: 15 * 60_000, limit: 20 });
const mfaLimiter = rateLimit({ prefix: 'auth-mfa', windowMs: 15 * 60_000, limit: 10 });
const sessionCookieName = env.NODE_ENV === 'production' ? '__Host-mediassist_session' : 'mediassist_session';
const sessionLifetimeMs = (env.NODE_ENV === 'production' ? 60 * 60 : 12 * 60 * 60) * 1000;
const sessionCookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: (env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
  maxAge: sessionLifetimeMs
};

function createSession(user: User): string {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, sessionVersion: user.sessionVersion ?? 0, purpose: 'session' }, env.JWT_SECRET, {
    algorithm: 'HS256', expiresIn: env.NODE_ENV === 'production' ? '1h' : '12h', issuer: 'mediassist-api', audience: 'mediassist-admin'
  });
}

function publicUser(user: User) { return { id: user.id, email: user.email, role: user.role }; }

function createMfaChallenge(user: User, mode: 'setup' | 'verify'): string {
  return jwt.sign({ sub: user.id, sessionVersion: user.sessionVersion ?? 0, purpose: 'mfa', mfaMode: mode }, env.JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '10m', issuer: 'mediassist-api', audience: 'mediassist-admin'
  });
}

function isAllowedBrowserOrigin(req: import('express').Request): boolean {
  const origin = req.header('origin');
  return !origin || adminOrigins.includes(origin);
}

function sendSession(req: import('express').Request, res: import('express').Response, user: User, extra: Record<string, unknown> = {}): void {
  const payload: Record<string, unknown> = { user: publicUser(user), ...extra };
  if (req.header('origin')) setSessionCookie(res, user);
  else payload.token = createSession(user);
  res.json(payload);
}

async function readMfaChallenge(req: import('express').Request, mode: 'setup' | 'verify'): Promise<User | null> {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'mediassist-api', audience: 'mediassist-admin' }) as jwt.JwtPayload;
    if (payload.purpose !== 'mfa' || payload.mfaMode !== mode || typeof payload.sub !== 'string') return null;
    const user = await getRecord<User>(collection.users, payload.sub);
    if (!user || user.active === false || user.role !== 'admin' || (payload.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) return null;
    return user;
  } catch { return null; }
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/\s+/g, '').toUpperCase()).digest('hex');
}

function setSessionCookie(res: import('express').Response, user: User): void {
  res.cookie(sessionCookieName, createSession(user), sessionCookieOptions);
}

authRouter.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const origin = req.header('origin');
  if (origin && !adminOrigins.includes(origin)) return res.status(403).json({ error: 'This browser origin is not allowed to sign in.' });
  const input = z.object({ email: z.string().email(), password: z.string().min(1).max(256) }).parse(req.body);
  const user = await findRecordByField<User>(collection.users, 'email', input.email.toLowerCase());
  if (!user || !await bcrypt.compare(input.password, user.passwordHash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (user.active === false) return res.status(401).json({ error: 'This account has been disabled.' });
  if (user.role === 'admin' && env.REQUIRE_ADMIN_MFA === 'true') {
    const mode = user.mfaEnabled && user.mfaSecretEnc ? 'verify' : 'setup';
    return res.json({ mfaRequired: true, mode, challenge: createMfaChallenge(user, mode) });
  }
  if (origin) {
    setSessionCookie(res, user);
    res.json({ user: publicUser(user) });
  } else {
    res.json({ token: createSession(user), user: publicUser(user) });
  }
}));

authRouter.post('/mfa/setup', mfaLimiter, asyncRoute(async (req, res) => {
  if (!isAllowedBrowserOrigin(req)) return res.status(403).json({ error: 'This browser origin is not allowed.' });
  const user = await readMfaChallenge(req, 'setup');
  if (!user || user.mfaEnabled) return res.status(401).json({ error: 'This MFA setup session is invalid or expired. Sign in again.' });
  const secret = createTotpSecret();
  const encryptedSecret = encryptMfaSecret(secret);
  const updated = await updateUserRecord<User>(user.id, (current) => {
    if (current.active === false || current.role !== 'admin' || current.mfaEnabled
      || (current.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) return null;
    return { ...current, mfaPendingSecretEnc: encryptedSecret };
  });
  if (!updated) return res.status(401).json({ error: 'This MFA setup session is invalid or expired. Sign in again.' });
  res.json({ secret, otpauthUrl: createTotpUri(secret, user.email) });
}));

authRouter.post('/mfa/enable', mfaLimiter, asyncRoute(async (req, res) => {
  if (!isAllowedBrowserOrigin(req)) return res.status(403).json({ error: 'This browser origin is not allowed.' });
  const user = await readMfaChallenge(req, 'setup');
  const pendingSecret = user?.mfaPendingSecretEnc;
  if (!user || user.mfaEnabled || !pendingSecret) return res.status(401).json({ error: 'This MFA setup session is invalid or expired. Start setup again.' });
  const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const secret = decryptMfaSecret(pendingSecret);
  if (!verifyTotp(secret, input.code)) return res.status(400).json({ error: 'That authenticator code is invalid or expired.' });
  const recoveryCodes = createRecoveryCodes();
  const enabled = await updateUserRecord<User>(user.id, (current) => {
    if (current.active === false || current.role !== 'admin' || current.mfaEnabled
      || (current.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)
      || current.mfaPendingSecretEnc !== pendingSecret) return null;
    const updated: User = { ...current, mfaSecretEnc: pendingSecret, mfaEnabled: true, recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode) };
    delete updated.mfaPendingSecretEnc;
    return updated;
  });
  if (!enabled) return res.status(401).json({ error: 'This MFA setup session is invalid or expired. Start setup again.' });
  sendSession(req, res, enabled, { recoveryCodes });
}));

authRouter.post('/mfa/verify', mfaLimiter, asyncRoute(async (req, res) => {
  if (!isAllowedBrowserOrigin(req)) return res.status(403).json({ error: 'This browser origin is not allowed.' });
  const user = await readMfaChallenge(req, 'verify');
  if (!user || !user.mfaEnabled || !user.mfaSecretEnc) return res.status(401).json({ error: 'This MFA sign-in session is invalid or expired. Sign in again.' });
  const input = z.object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(16).max(64).optional() }).refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode)).parse(req.body);
  if (input.code) {
    if (!verifyTotp(decryptMfaSecret(user.mfaSecretEnc), input.code)) return res.status(401).json({ error: 'That authenticator code is invalid or expired.' });
  } else {
    const updated = await consumeUserRecoveryCode(user.id, hashRecoveryCode(input.recoveryCode!), user.sessionVersion ?? 0);
    if (!updated) return res.status(401).json({ error: 'That recovery code is invalid or has already been used.' });
    Object.assign(user, updated);
  }
  sendSession(req, res, user);
}));

authRouter.post('/mfa/recovery-codes', requireAuth, mfaLimiter, asyncRoute(async (req, res) => {
  if (!isAllowedBrowserOrigin(req)) return res.status(403).json({ error: 'This browser origin is not allowed.' });
  const user = req.user!;
  if (user.role !== 'admin' || !user.mfaEnabled || !user.mfaSecretEnc) return res.status(403).json({ error: 'Authenticator MFA is not enabled for this administrator.' });
  const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  if (!verifyTotp(decryptMfaSecret(user.mfaSecretEnc), input.code)) return res.status(401).json({ error: 'That authenticator code is invalid or expired.' });
  const recoveryCodes = createRecoveryCodes();
  const updated = await updateUserRecord<User>(user.id, (current) => {
    if (current.active === false || current.role !== 'admin' || !current.mfaEnabled
      || current.mfaSecretEnc !== user.mfaSecretEnc
      || (current.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) return null;
    return { ...current, recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode) };
  });
  if (!updated) return res.status(401).json({ error: 'The account changed; sign in again before replacing recovery codes.' });
  res.json({ recoveryCodes });
}));

authRouter.post('/logout', asyncRoute(async (req, res) => {
  const origin = req.header('origin');
  if (origin && !adminOrigins.includes(origin)) return res.status(403).json({ error: 'This browser origin is not allowed to sign out.' });
  const tokens = new Set([
    req.header('authorization')?.replace(/^Bearer\s+/i, ''),
    readCookie(req.header('cookie'), sessionCookieName)
  ].filter((token): token is string => Boolean(token)));
  for (const token of tokens) {
    let payload: jwt.JwtPayload | null = null;
    try {
      payload = jwt.verify(token, env.JWT_SECRET, {
        algorithms: ['HS256'], issuer: 'mediassist-api', audience: 'mediassist-admin'
      }) as jwt.JwtPayload;
    } catch { /* Clearing an expired or invalid session cookie is still safe. */ }
    if ((payload?.purpose === undefined || payload.purpose === 'session') && typeof payload?.sub === 'string') {
      const subject = payload.sub;
      const tokenSessionVersion = typeof payload.sessionVersion === 'number' ? payload.sessionVersion : 0;
      await updateUserRecord<User>(subject, (current) => {
        if (current.active === false
          || tokenSessionVersion !== (current.sessionVersion ?? 0)) return null;
        return { ...current, sessionVersion: (current.sessionVersion ?? 0) + 1 };
      });
    }
  }
  res.clearCookie(sessionCookieName, { ...sessionCookieOptions, maxAge: undefined });
  res.status(204).end();
}));

authRouter.post('/change-password', requireAuth, asyncRoute(async (req, res) => {
  const input = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(12).max(256) }).parse(req.body);
  const user = req.user!;
  if (!await bcrypt.compare(input.currentPassword, user.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
  if (input.currentPassword === input.newPassword) return res.status(400).json({ error: 'Choose a different password.' });
  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  const updated = await updateUserRecord<User>(user.id, (current) => {
    if (current.active === false || (current.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) return null;
    return { ...current, passwordHash, sessionVersion: (current.sessionVersion ?? 0) + 1 };
  });
  if (!updated) return res.status(409).json({ error: 'This account changed during the request. Sign in again and retry.' });
  sendSession(req, res, updated);
}));

authRouter.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const user = await getRecord<User>(collection.users, req.user!.id);
  res.json({ user: user && { id: user.id, email: user.email, role: user.role } });
}));

export function createUser(input: { email: string; password: string; role?: 'admin' | 'staff' }): Promise<User> {
  const user: User = { id: randomUUID(), email: input.email.toLowerCase(), passwordHash: '', role: input.role ?? 'staff', active: true, createdAt: new Date().toISOString() };
  return bcrypt.hash(input.password, 12).then(async (passwordHash) => {
    user.passwordHash = passwordHash;
    const result = await insertRecordIfUniqueField(collection.users, user, 'email');
    if (!result.inserted) throw new Error('A user with this email already exists.');
    return result.record;
  });
}
