import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { env, validateProductionConfig } from '../config/env.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { nextAttemptDelay } from './backoff.js';
import { verifyBody, signBody } from './hmac.js';
import { redactPhi } from './redact.js';
import { decryptMfaSecret, decryptSecret, encryptMfaSecret, encryptSecret } from './secrets.js';
import { createTotpSecret, createTotpUri, totpAt, verifyTotp } from './totp.js';
import { postWebhook, resolveWebhookTarget, WebhookPolicyError } from './secureWebhook.js';
import { sanitizeEventPayload } from '../modules/events/service.js';
import { soapSummarySchema } from '../modules/notes/schemas.js';

test('PHI redaction applies specific DOB and identity rules before phone matching', () => {
  const input = 'Patient: Jane Doe, DOB: 01/02/1980, MRN: ABCD1234, SSN: 123-45-6789, phone +1 (202) 555-0199, email jane@example.com';
  const output = redactPhi(input);

  assert.match(output, /Patient: \[REDACTED_NAME\]/);
  assert.match(output, /DOB: \[REDACTED_DATE\]/);
  assert.match(output, /MRN: \[REDACTED_ID\]/);
  assert.match(output, /\[REDACTED_PHONE\]/);
  assert.match(output, /\[REDACTED_EMAIL\]/);
  for (const sensitive of ['Jane Doe', '01/02/1980', 'ABCD1234', '123-45-6789', '202) 555-0199', 'jane@example.com']) {
    assert.ok(!output.includes(sensitive), `Expected ${sensitive} to be redacted`);
  }
});

test('SOAP output schema bounds provider-controlled text and list sizes', () => {
  assert.throws(() => soapSummarySchema.parse({ subjective: '', objective: '', assessment: '', plan: '', followUps: Array.from({ length: 51 }, () => 'follow-up') }));
  assert.throws(() => soapSummarySchema.parse({ subjective: 'x'.repeat(10_001), objective: '', assessment: '', plan: '' }));
  assert.deepEqual(soapSummarySchema.parse({ subjective: 'short', objective: '', assessment: '', plan: '' }).followUps, []);
});

test('HMAC verification accepts the signed body and rejects tampering or stale timestamps', () => {
  const body = JSON.stringify({ type: 'booking.created', data: { bookingId: 'test-123' } });
  const secret = 'smoke-test-shared-secret';
  const now = Math.floor(Date.now() / 1000);
  const signature = signBody(body, secret, now);

  assert.equal(verifyBody(body, signature, secret), true);
  assert.equal(verifyBody(`${body} `, signature, secret), false);
  assert.equal(verifyBody(body, undefined, secret), false);
  assert.equal(verifyBody(body, signBody(body, secret, now - 301), secret), false);
  assert.equal(verifyBody(body, 't=now,v1=not-hex', secret), false);
});

test('webhook secret encryption round-trips and authenticates its ciphertext', () => {
  const encrypted = encryptSecret('endpoint-secret-for-tests');
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(decryptSecret(encrypted), 'endpoint-secret-for-tests');

  const damaged = `${encrypted.slice(0, -1)}${encrypted.endsWith('0') ? '1' : '0'}`;
  assert.throws(() => decryptSecret(damaged));
});

test('authenticator secrets encrypt safely and TOTP follows the RFC 6238 SHA-1 vector', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const encrypted = encryptMfaSecret(secret);
  assert.equal(decryptMfaSecret(encrypted), secret);
  assert.throws(() => decryptMfaSecret(`${encrypted.slice(0, -1)}0`));
  assert.equal(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082');
  assert.equal(verifyTotp(secret, '287082', 59_000), true);
  assert.equal(verifyTotp(secret, '287083', 59_000), false);
  assert.match(createTotpSecret(), /^[A-Z2-7]{32}$/);
  assert.match(createTotpUri(secret, 'admin@example.test'), /^otpauth:\/\/totp\//);
});

test('webhook backoff applies bounded jitter and stops after its configured attempts', () => {
  assert.equal(nextAttemptDelay(1, 1, () => 0), 4_000);
  assert.equal(nextAttemptDelay(1, 1, () => 0.5), 5_000);
  assert.equal(nextAttemptDelay(1, 1, () => 1), 6_000);
  assert.equal(nextAttemptDelay(1, 0.05, () => 0.5), 250);
  assert.equal(nextAttemptDelay(4, 1, () => 0.5), 600_000);
  assert.equal(nextAttemptDelay(5, 1, () => 0.5), null);
  assert.equal(nextAttemptDelay(0, 1, () => 0.5), null);
});

test('circuit breaker opens on repeated failures and allows a single recovery probe', async () => {
  const breaker = new CircuitBreaker(2, 20);
  breaker.failure();
  assert.equal(breaker.state, 'closed');
  breaker.failure();
  assert.equal(breaker.state, 'open');
  assert.throws(() => breaker.enter(), /circuit is open/);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(breaker.state, 'half-open');
  breaker.enter();
  assert.throws(() => breaker.enter(), /checking recovery/);
  breaker.success();
  assert.equal(breaker.state, 'closed');
  assert.doesNotThrow(() => breaker.enter());
});

test('production configuration requires hosted state, verified HTTPS integrations, and a real LLM', () => {
  const valid = {
    ...env,
    NODE_ENV: 'production' as const,
    DATABASE_URL: 'postgresql://mediassist:secret@db.example.com/mediassist',
    MONGO_URL: 'mongodb+srv://mediassist:secret@logs.example.com/mediassist',
    JWT_SECRET: 'a'.repeat(48),
    WEBHOOK_ENCRYPTION_KEY: 'b'.repeat(48),
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'A-strong-unique-password-2026',
    MEDIBOOK_BASE_URL: 'https://medibook.example.com',
    MEDIBOOK_SERVICE_KEY: 'c'.repeat(32),
    MEDIBOOK_WEBHOOK_SECRET: 'd'.repeat(48),
    LLM_API_KEY: 'provider-secret',
    LLM_BASE_URL: 'https://llm.example.com/v1',
    MOCK_LLM: 'false' as const,
    STORE_RAW_NOTES: 'false' as const,
    REQUIRE_ADMIN_MFA: 'true' as const,
    CLINICAL_NOTE_RETENTION_DAYS: 2555,
    CORS_ADMIN_ORIGIN: 'https://admin.example.com',
    PUBLIC_BASE_URL: 'https://api.example.com'
  };
  assert.doesNotThrow(() => validateProductionConfig(valid));
  assert.throws(() => validateProductionConfig({ ...valid, DATABASE_URL: '' }), /DATABASE_URL/);
  assert.throws(() => validateProductionConfig({ ...valid, MOCK_LLM: 'true' }), /MOCK_LLM/);
  assert.throws(() => validateProductionConfig({ ...valid, REQUIRE_ADMIN_MFA: 'false' }), /REQUIRE_ADMIN_MFA/);
  assert.throws(() => validateProductionConfig({ ...valid, CLINICAL_NOTE_RETENTION_DAYS: -1 }), /CLINICAL_NOTE_RETENTION_DAYS/);
  assert.doesNotThrow(() => validateProductionConfig({ ...valid, CLINICAL_NOTE_RETENTION_DAYS: 0 }));
  assert.throws(() => validateProductionConfig({ ...valid, JSON_BODY_LIMIT: '2mb' }), /JSON_BODY_LIMIT/);
  assert.throws(() => validateProductionConfig({ ...valid, CORS_ADMIN_ORIGIN: 'https://admin.example.com,https://other.example.com/' }), /exact HTTPS origins/);
});

test('event automation payloads omit sensitive fields and redact identifier patterns', () => {
  const safe = sanitizeEventPayload({
    bookingId: 'booking-123',
    name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+1 (202) 555-0199',
    birthDate: '1980-01-02',
    slot: { date: '2030-01-02', time: '09:30', clinician: 'Dr. Example' },
    details: 'Patient: John Example called from 202-555-0134'
  }) as Record<string, unknown>;
  assert.equal(safe.name, undefined);
  assert.equal(safe.email, undefined);
  assert.equal(safe.phone, undefined);
  assert.equal(safe.birthDate, undefined);
  assert.deepEqual(safe.slot, { date: '2030-01-02', time: '09:30', clinician: 'Dr. Example' });
  assert.doesNotMatch(String(safe.details), /John Example|202-555-0134/);
});

test('webhook target validation rejects loopback and private network destinations', async () => {
  await assert.rejects(resolveWebhookTarget('https://127.0.0.1/callback'), WebhookPolicyError);
  await assert.rejects(resolveWebhookTarget('https://10.0.0.8/callback'), WebhookPolicyError);
  await assert.rejects(resolveWebhookTarget('https://[::1]/callback'), WebhookPolicyError);
  await assert.rejects(resolveWebhookTarget('http://example.com/callback'), WebhookPolicyError);
  const local = await resolveWebhookTarget('http://localhost:4000/sandbox/receiver/test-id', true);
  assert.equal(local.localSandbox, true);
});

test('webhook transport pins loopback for the sandbox and never follows redirects', async () => {
  let receivedBody = '';
  const receiver = createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk) => { receivedBody += chunk; });
    request.on('end', () => { response.writeHead(302, { location: 'http://127.0.0.1/private' }); response.end(); });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  try {
    const address = receiver.address();
    assert.ok(address && typeof address !== 'string');
    const target = await resolveWebhookTarget(`http://localhost:${address.port}/sandbox/receiver/test-id`, true);
    const status = await postWebhook(target, '{"type":"test"}', 't=1,v1=test', 'test-correlation', 1500);
    assert.equal(status, 302);
    assert.equal(receivedBody, '{"type":"test"}');
  } finally {
    receiver.close();
    await once(receiver, 'close');
  }
});
