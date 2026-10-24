import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function createTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function createTotpUri(secret: string, account: string): string {
  const label = encodeURIComponent(`MediAssist:${account}`);
  const query = new URLSearchParams({ secret, issuer: 'MediAssist', algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function verifyTotp(secret: string, suppliedCode: string, nowMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(suppliedCode)) return false;
  const supplied = Buffer.from(suppliedCode);
  const currentStep = Math.floor(nowMs / 30_000);
  for (let offset = -1; offset <= 1; offset += 1) {
    const expected = Buffer.from(totpAt(secret, currentStep + offset));
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return true;
  }
  return false;
}

export function totpAt(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/, '')) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Authenticator secret is malformed.');
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (output.length < 10) throw new Error('Authenticator secret is too short.');
  return Buffer.from(output);
}

export function createRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => randomBytes(10).toString('hex').toUpperCase());
}
