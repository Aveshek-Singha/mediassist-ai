import { createHmac, timingSafeEqual } from 'node:crypto';

export function signBody(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifyBody(body: string, header: string | undefined, secret: string, toleranceSeconds = 300): boolean {
  if (!header) return false;
  const fields = Object.fromEntries(header.split(',').map((part) => part.split('=')));
  const timestamp = Number(fields.t);
  const signature = fields.v1;
  if (!Number.isInteger(timestamp) || !signature || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  let provided: Buffer;
  try { provided = Buffer.from(signature, 'hex'); } catch { return false; }
  return provided.length === expected.length && timingSafeEqual(expected, provided);
}
