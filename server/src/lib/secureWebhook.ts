import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type ResolvedWebhookTarget = { url: URL; address: string; family: 4 | 6; localSandbox: boolean };

export class WebhookPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'WebhookPolicyError'; }
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) return isPrivateIpv4(address);
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (mapped.includes('.')) return isPrivateIpv4(mapped);
    const value = Number.parseInt(mapped.replaceAll(':', '').slice(-8), 16);
    if (!Number.isFinite(value)) return true;
    return isPrivateIpv4([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'));
  }
  if (normalized === '::' || normalized === '::1') return true;
  const firstSegment = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if (!Number.isFinite(firstSegment)) return true;
  return (firstSegment & 0xfe00) === 0xfc00 // unique-local fc00::/7
    || (firstSegment & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (firstSegment & 0xff00) === 0xff00 // multicast ff00::/8
    || (firstSegment === 0x2001 && normalized.split(':')[1] === 'db8'); // documentation range
}

export async function resolveWebhookTarget(rawUrl: string, allowLocalSandbox = false): Promise<ResolvedWebhookTarget> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new WebhookPolicyError('Webhook URL is invalid.'); }
  const hostname = hostWithoutBrackets(url.hostname).toLowerCase();
  if (url.username || url.password || url.hash) throw new WebhookPolicyError('Webhook URL must not contain credentials or a fragment.');
  if (!['http:', 'https:'].includes(url.protocol)) throw new WebhookPolicyError('Webhook URL must use HTTPS.');

  const localNames = new Set(['localhost', '127.0.0.1', '::1']);
  const localSandbox = allowLocalSandbox && url.protocol === 'http:' && localNames.has(hostname)
    && url.pathname.startsWith('/sandbox/receiver/');
  if (url.protocol !== 'https:' && !localSandbox) throw new WebhookPolicyError('Webhook destinations must use HTTPS.');
  if (localSandbox && url.pathname.split('/').filter(Boolean).length !== 3) throw new WebhookPolicyError('Invalid local sandbox URL.');

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Webhook host could not be resolved.');
  }
  if (addresses.length === 0) throw new Error('Webhook host did not resolve to an address.');
  if (localSandbox) {
    if (addresses.some((item) => !(item.address === '127.0.0.1' || item.address === '::1'))) throw new WebhookPolicyError('Local sandbox URLs must resolve only to loopback addresses.');
  } else if (addresses.some((item) => isPrivateAddress(item.address, item.family))) {
    throw new WebhookPolicyError('Webhook destinations cannot resolve to private or reserved network addresses.');
  }
  const selected = addresses.find((item) => item.family === 4) ?? addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6, localSandbox };
}

export async function postWebhook(target: ResolvedWebhookTarget, body: string, signature: string, requestId: string, timeoutMs = 3000): Promise<number> {
  const { url, address } = target;
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const hostname = hostWithoutBrackets(url.hostname);
  const requestOptions = {
    protocol: url.protocol,
    hostname: address,
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    headers: {
      host: url.host,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-mediassist-signature': signature,
      'x-request-id': requestId
    },
    ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {})
  };

  return new Promise((resolve, reject) => {
    const request = requestFn(requestOptions, (response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      response.once('end', () => resolve(statusCode));
      response.once('error', reject);
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error('Webhook request timed out.');
      error.name = 'TimeoutError';
      request.destroy(error);
    });
    request.once('error', reject);
    request.end(body);
  });
}

export function safeWebhookFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'Webhook request timed out.';
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return `Webhook connection failed (${code}).`;
  return 'Webhook request failed.';
}
