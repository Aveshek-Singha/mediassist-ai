import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../config/env.js';

const encryptionKey = scryptSync(env.WEBHOOK_ENCRYPTION_KEY, 'mediassist-webhook-secret-v1', 32);
const mfaEncryptionKey = scryptSync(env.WEBHOOK_ENCRYPTION_KEY, 'mediassist-mfa-secret-v1', 32);
const prefix = 'enc:v1:';
const mfaPrefix = 'mfa:v1:';

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(prefix)) return stored;
  const [ivHex, tagHex, ciphertextHex] = stored.slice(prefix.length).split(':');
  if (!ivHex || !tagHex || !ciphertextHex) throw new Error('Stored webhook secret is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
}

export function encryptMfaSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mfaEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return `${mfaPrefix}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptMfaSecret(stored: string): string {
  if (!stored.startsWith(mfaPrefix)) throw new Error('Stored authenticator secret is invalid.');
  const [ivHex, tagHex, ciphertextHex] = stored.slice(mfaPrefix.length).split(':');
  if (!ivHex || !tagHex || !ciphertextHex) throw new Error('Stored authenticator secret is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', mfaEncryptionKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
}
