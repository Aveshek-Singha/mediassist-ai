import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

const apiBase = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const dashboardBase = (process.env.DASHBOARD_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const demoBase = (process.env.DEMO_BASE_URL || 'http://localhost:5174').replace(/\/$/, '');
const mockBase = (process.env.MOCK_BASE_URL || 'http://localhost:4100').replace(/\/$/, '');
const runId = randomUUID().replaceAll('-', '');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function currentTotp(secret) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of secret) {
    value = (value << 5) | base32Alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

async function request(base, path, options = {}) {
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body !== undefined && typeof body !== 'string') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(body);
  } else if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${base}${path}`, { ...options, headers, body });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, payload };
}

function expectStatus(result, status, description) {
  assert.equal(result.response.status, status, `${description}: expected HTTP ${status}, got ${result.response.status}; body=${JSON.stringify(result.payload)}`);
}

function pass(description) {
  console.log(`PASS ${description}`);
}

async function api(path, options = {}) {
  return request(apiBase, path, options);
}

async function waitUntil(description, operation, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await operation();
    if (predicate(value)) return value;
    await pause(250);
  }
  assert.fail(`Timed out waiting for ${description}. Last value: ${JSON.stringify(value)}`);
}

async function nextWeekdayWithSlots() {
  const date = new Date();
  for (let offset = 0; offset < 60; offset += 1) {
    date.setUTCDate(date.getUTCDate() + 1);
    if ([0, 6].includes(date.getUTCDay())) continue;
    const candidate = date.toISOString().slice(0, 10);
    const result = await request(mockBase, `/slots?date=${candidate}`, { headers: { 'x-service-key': 'local-medibook-service-key' } });
    if (result.response.ok && result.payload.slots.length >= 2) return candidate;
  }
  assert.fail('MediBook had no open weekday slot in the next 60 days.');
}

async function main() {
  const [dashboard, demo, health, docs, spec, widget, mockHealth, mockUnauthorized] = await Promise.all([
    request(dashboardBase, '/'),
    request(demoBase, '/'),
    api('/health', { headers: { 'x-request-id': `smoke-health-${runId}` } }),
    api('/docs'),
    api('/openapi.json'),
    api('/widget.js'),
    request(mockBase, '/health'),
    request(mockBase, '/slots?date=2030-01-02')
  ]);
  expectStatus(dashboard, 200, 'Dashboard serves');
  assert.ok(dashboard.payload.includes('/src/main.tsx'));
  expectStatus(demo, 200, 'Separate-origin widget demo serves');
  assert.match(demo.payload, /http:\/\/localhost:4000\/widget\.js/);
  expectStatus(health, 200, 'API health');
  assert.equal(health.payload.database.mode, 'file');
  assert.equal(health.payload.database.ok, true);
  assert.equal(health.payload.logs.ok, true);
  assert.equal(health.response.headers.get('x-request-id'), `smoke-health-${runId}`);
  expectStatus(docs, 200, 'API docs serve');
  assert.match(docs.response.headers.get('content-security-policy') || '', /default-src 'self'/);
  expectStatus(spec, 200, 'OpenAPI document serves');
  assert.equal(spec.payload.openapi, '3.0.3');
  expectStatus(widget, 200, 'Widget bundle serves');
  assert.match(widget.payload, /attachShadow/);
  assert.match(widget.payload, /Clinic privacy notice/);
  assert.doesNotMatch(widget.payload, /Sample data in this demo/);
  assert.ok(Buffer.byteLength(widget.payload) < 30_000, 'Widget bundle should remain below 30 KB');
  assert.equal(widget.response.headers.get('cache-control'), 'no-cache');
  expectStatus(mockHealth, 200, 'MediBook mock health');
  expectStatus(mockUnauthorized, 401, 'MediBook service key is required');
  pass('dashboard, demo, API docs, widget bundle, and MediBook mock are reachable');

  const deniedLogin = await api('/auth/login', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { email: 'admin@mediassist.local', password: 'incorrect-password' } });
  expectStatus(deniedLogin, 401, 'Invalid admin credentials are rejected');
  const login = await api('/auth/login', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { email: 'admin@mediassist.local', password: 'change-this-demo-password' } });
  expectStatus(login, 200, 'Seed admin login');
  let sessionResponse = login;
  if (login.payload.mfaRequired) {
    assert.equal(login.payload.mode, 'setup');
    const challengeHeaders = { authorization: `Bearer ${login.payload.challenge}`, origin: 'http://localhost:5173' };
    const setup = await api('/auth/mfa/setup', { method: 'POST', headers: challengeHeaders, body: {} });
    expectStatus(setup, 200, 'MFA setup challenge returns a TOTP secret');
    assert.match(setup.payload.otpauthUrl, /^otpauth:\/\/totp\//);
    const enabled = await api('/auth/mfa/enable', { method: 'POST', headers: challengeHeaders, body: { code: currentTotp(setup.payload.secret) } });
    expectStatus(enabled, 200, 'Admin enables authenticator MFA');
    assert.equal(enabled.payload.recoveryCodes.length, 10);
    assert.equal(Object.hasOwn(enabled.payload, 'token'), false, 'Browser MFA completion must not expose a token');

    const verifyLogin = await api('/auth/login', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { email: 'admin@mediassist.local', password: 'change-this-demo-password' } });
    expectStatus(verifyLogin, 200, 'MFA admin login returns a verification challenge');
    assert.equal(verifyLogin.payload.mode, 'verify');
    const verified = await api('/auth/mfa/verify', { method: 'POST', headers: { authorization: `Bearer ${verifyLogin.payload.challenge}`, origin: 'http://localhost:5173' }, body: { code: currentTotp(setup.payload.secret) } });
    expectStatus(verified, 200, 'Authenticator code completes browser sign-in');
    sessionResponse = verified;

    const recoveryLogin = await api('/auth/login', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { email: 'admin@mediassist.local', password: 'change-this-demo-password' } });
    const recoveryCode = enabled.payload.recoveryCodes[0];
    const recoveryUse = await api('/auth/mfa/verify', { method: 'POST', headers: { authorization: `Bearer ${recoveryLogin.payload.challenge}`, origin: 'http://localhost:5173' }, body: { recoveryCode } });
    expectStatus(recoveryUse, 200, 'One-time recovery code can restore access');
    const replayLogin = await api('/auth/login', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { email: 'admin@mediassist.local', password: 'change-this-demo-password' } });
    const replayRecovery = await api('/auth/mfa/verify', { method: 'POST', headers: { authorization: `Bearer ${replayLogin.payload.challenge}`, origin: 'http://localhost:5173' }, body: { recoveryCode } });
    expectStatus(replayRecovery, 401, 'Recovery codes cannot be reused');
    const activeCookie = (verified.response.headers.get('set-cookie') || '').split(';', 1)[0];
    const rotatedCodes = await api('/auth/mfa/recovery-codes', { method: 'POST', headers: { cookie: activeCookie, origin: 'http://localhost:5173' }, body: { code: currentTotp(setup.payload.secret) } });
    expectStatus(rotatedCodes, 200, 'MFA recovery codes can be rotated by an authenticated administrator');
    assert.equal(rotatedCodes.payload.recoveryCodes.length, 10);
    const oldCodeLogin = await api('/auth/login', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { email: 'admin@mediassist.local', password: 'change-this-demo-password' } });
    const oldCodeAttempt = await api('/auth/mfa/verify', { method: 'POST', headers: { authorization: `Bearer ${oldCodeLogin.payload.challenge}`, origin: 'http://localhost:5173' }, body: { recoveryCode: enabled.payload.recoveryCodes[1] } });
    expectStatus(oldCodeAttempt, 401, 'Rotating recovery codes invalidates the previous set');
    pass('Required admin TOTP enrollment, verification, recovery codes, and one-time use');
  }
  const setCookie = sessionResponse.response.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/i, 'Browser session cookie must be HttpOnly');
  assert.match(setCookie, /SameSite=Lax/i, 'Development browser session cookie must be SameSite=Lax');
  assert.equal(Object.hasOwn(login.payload, 'token'), false, 'Login must not expose the session token to JavaScript');
  const sessionCookie = setCookie.split(';', 1)[0];
  assert.ok(sessionCookie);
  expectStatus(await api('/auth/me'), 401, 'Protected route rejects a missing session');
  const me = await api('/auth/me', { headers: { cookie: sessionCookie } });
  expectStatus(me, 200, 'HttpOnly cookie session resolves');
  assert.equal(me.payload.user.email, 'admin@mediassist.local');
  const admin = (path, options = {}) => api(path, { ...options, headers: { cookie: sessionCookie, origin: 'http://localhost:5173', ...(options.headers || {}) } });
  expectStatus(await admin(`/users/${me.payload.user.id}`, { method: 'PATCH', body: { active: false } }), 409, 'The last active administrator cannot be disabled');
  const csrfAttempt = await api('/api-keys', { method: 'POST', headers: { cookie: sessionCookie, origin: 'https://attacker.example' }, body: { clinicId: `csrf-${runId}`, allowedOrigins: ['https://clinic.example'] } });
  expectStatus(csrfAttempt, 403, 'Cookie-authenticated state changes reject an untrusted Origin');
  pass('HttpOnly cookie login, missing-session rejection, and CSRF origin validation');

  const staffCreated = await admin('/users', { method: 'POST', body: { email: `staff-${runId}@example.test`, password: `Staff-${runId}-secure-pass`, role: 'staff' } });
  expectStatus(staffCreated, 201, 'Administrator creates staff user');
  const apiClientLogin = await api('/auth/login', { method: 'POST', body: { email: staffCreated.payload.user.email, password: `Staff-${runId}-secure-pass` } });
  expectStatus(apiClientLogin, 200, 'Non-browser API client login');
  assert.match(apiClientLogin.payload.token, /^eyJ/);
  const apiClientSession = { authorization: `Bearer ${apiClientLogin.payload.token}` };
  expectStatus(await api('/auth/me', { headers: apiClientSession }), 200, 'Bearer token resolves an API session');
  expectStatus(await api('/auth/logout', { method: 'POST', headers: apiClientSession }), 204, 'API client logout revokes its bearer session');
  expectStatus(await api('/auth/me', { headers: apiClientSession }), 401, 'Logged-out bearer token cannot be reused');
  const staffLogin = await api('/auth/login', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { email: staffCreated.payload.user.email, password: `Staff-${runId}-secure-pass` } });
  expectStatus(staffLogin, 200, 'Staff user login');
  let staffCookie = (staffLogin.response.headers.get('set-cookie') || '').split(';', 1)[0];
  const staff = (path, options = {}) => api(path, { ...options, headers: { cookie: staffCookie, origin: 'http://localhost:5173', ...(options.headers || {}) } });
  expectStatus(await staff('/notes'), 200, 'Staff can access visit-note workspace');
  expectStatus(await staff('/templates'), 403, 'Staff cannot access administrative prompt templates');
  expectStatus(await staff('/webhooks/deliveries'), 403, 'Staff cannot access webhook delivery records');
  expectStatus(await staff('/users'), 403, 'Staff cannot administer accounts');
  const oldStaffCookie = staffCookie;
  const changedPassword = await staff('/auth/change-password', { method: 'POST', body: { currentPassword: `Staff-${runId}-secure-pass`, newPassword: `Staff-${runId}-changed-pass` } });
  expectStatus(changedPassword, 200, 'Staff can change their password');
  staffCookie = (changedPassword.response.headers.get('set-cookie') || '').split(';', 1)[0];
  expectStatus(await api('/auth/me', { headers: { cookie: oldStaffCookie } }), 401, 'Password changes revoke the previous session');
  expectStatus(await staff('/auth/me'), 200, 'Password changes issue a fresh browser session');
  expectStatus(await admin(`/users/${staffCreated.payload.user.id}`, { method: 'PATCH', body: { active: false } }), 200, 'Administrator disables staff user');
  expectStatus(await staff('/auth/me'), 401, 'Disabling a user revokes existing sessions');
  pass('Staff and administrator permissions, account provisioning, and immediate revocation');

  const mockDate = await nextWeekdayWithSlots();
  const mockSlots = await request(mockBase, `/slots?date=${mockDate}`, { headers: { 'x-service-key': 'local-medibook-service-key' } });
  expectStatus(mockSlots, 200, 'MediBook mock slots');
  assert.ok(mockSlots.payload.slots.length > 0);
  const internalSlots = await admin(`/medibook/slots?date=${mockDate}`);
  expectStatus(internalSlots, 200, 'Authenticated MediBook slots proxy');
  assert.ok(internalSlots.payload.slots.length > 0);
  const noPublicKey = await api(`/public/slots?date=${mockDate}`, { headers: { origin: 'http://localhost:5174' } });
  expectStatus(noPublicKey, 401, 'Widget API requires public key');
  const disallowedOrigin = await api(`/public/slots?date=${mockDate}`, { headers: { 'x-api-key': 'pk_test_mediassist', origin: 'https://not-allowed.example' } });
  expectStatus(disallowedOrigin, 403, 'Seed widget key enforces its origin allowlist');
  const preflight = await fetch(`${apiBase}/public/slots?date=${mockDate}`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key, idempotency-key, x-request-id, content-type' } });
  expectStatus({ response: preflight, payload: await preflight.text() }, 204, 'Widget CORS preflight');
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5174');
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /idempotency-key/i);

  const newKey = await admin('/api-keys', { method: 'POST', body: { clinicId: `smoke-${runId}`, allowedOrigins: ['http://localhost:5174'] } });
  expectStatus(newKey, 201, 'Create widget API key');
  assert.match(newKey.payload.publicKey, /^pk_live_/);
  const keyId = newKey.payload.key.id;
  let keySlots = await api(`/public/slots?date=${mockDate}`, { headers: { 'x-api-key': newKey.payload.publicKey, origin: 'http://localhost:5174' } });
  expectStatus(keySlots, 200, 'Created widget key can list slots');
  await admin(`/api-keys/${keyId}`, { method: 'PATCH', body: { allowedOrigins: ['http://127.0.0.1:5174'] } });
  keySlots = await api(`/public/slots?date=${mockDate}`, { headers: { 'x-api-key': newKey.payload.publicKey, origin: 'http://localhost:5174' } });
  expectStatus(keySlots, 403, 'Updated widget key allowlist takes effect');
  await admin(`/api-keys/${keyId}`, { method: 'PATCH', body: { enabled: false } });
  keySlots = await api(`/public/slots?date=${mockDate}`, { headers: { 'x-api-key': newKey.payload.publicKey, origin: 'http://127.0.0.1:5174' } });
  expectStatus(keySlots, 401, 'Disabled widget key is rejected');
  pass('MediBook slots, public key creation, origin allowlist, preflight, and key disable');

  const noteIdempotency = `smoke-note-${runId}`;
  const clinicalNote = `Patient: Jane Smoke, DOB: 01/02/1980, MRN: ZXCV${runId.slice(0, 4)}, phone +1 (202) 555-0147, email jane-${runId}@example.test reports a mild cough for two days.`;
  const missingIdempotency = await admin('/notes/summarize', { method: 'POST', body: { note: clinicalNote } });
  expectStatus(missingIdempotency, 400, 'Note summarization requires an idempotency key');
  const summarized = await admin('/notes/summarize', { method: 'POST', headers: { 'idempotency-key': noteIdempotency, 'x-request-id': `smoke-note-trace-${runId}` }, body: { note: clinicalNote } });
  expectStatus(summarized, 200, 'SOAP note is summarized');
  assert.equal(summarized.payload.note.status, 'completed');
  assert.equal(summarized.payload.note.provider, 'mock');
  assert.equal(typeof summarized.payload.note.summary.subjective, 'string');
  assert.match(summarized.payload.redactedText, /\[REDACTED_NAME\]/);
  assert.match(summarized.payload.redactedText, /\[REDACTED_DATE\]/);
  assert.match(summarized.payload.redactedText, /\[REDACTED_ID\]/);
  assert.match(summarized.payload.redactedText, /\[REDACTED_PHONE\]/);
  assert.match(summarized.payload.redactedText, /\[REDACTED_EMAIL\]/);
  for (const value of ['Jane Smoke', 'jane-', 'ZXCV', '555-0147']) assert.ok(!summarized.payload.redactedText.includes(value), `PHI value leaked into redacted output: ${value}`);
  const repeatedNote = await admin('/notes/summarize', { method: 'POST', headers: { 'idempotency-key': noteIdempotency }, body: { note: clinicalNote } });
  expectStatus(repeatedNote, 200, 'Repeated note request is idempotent');
  assert.equal(repeatedNote.payload.reused, true);
  assert.equal(repeatedNote.payload.note.id, summarized.payload.note.id);
  const conflictingNote = await admin('/notes/summarize', { method: 'POST', headers: { 'idempotency-key': noteIdempotency }, body: { note: 'A different input must not reuse this idempotency key.' } });
  expectStatus(conflictingNote, 409, 'Reusing a note idempotency key with a different body is rejected');
  const noteDetail = await admin(`/notes/${summarized.payload.note.id}`);
  expectStatus(noteDetail, 200, 'Visit note detail');
  assert.equal(Object.hasOwn(noteDetail.payload.note, 'rawText'), false);
  const noteList = await admin('/notes');
  expectStatus(noteList, 200, 'Visit note list');
  const listedNote = noteList.payload.notes.find((item) => item.id === summarized.payload.note.id);
  assert.ok(listedNote);
  assert.equal(Object.hasOwn(listedNote, 'rawText'), false);
  const pagedNotes = await admin('/notes?page=1&limit=1');
  expectStatus(pagedNotes, 200, 'Visit note pagination');
  assert.equal(pagedNotes.payload.pagination.limit, 1);
  assert.ok(pagedNotes.payload.notes.length <= 1);
  const noteLogs = await admin(`/logs?correlationId=smoke-note-trace-${runId}`);
  expectStatus(noteLogs, 200, 'Note logs can be searched by correlation ID');
  assert.ok(noteLogs.payload.items.some((item) => item.type === 'llm'));
  assert.ok(!JSON.stringify(noteLogs.payload).includes(`jane-${runId}@example.test`));
  pass('SOAP summary schema, PHI redaction, idempotency, safe note reads, and note logging');

  const template = await admin('/templates', { method: 'POST', body: { name: `Smoke template ${runId}`, body: 'Return a concise JSON event summary without inventing facts.', active: false } });
  expectStatus(template, 201, 'Prompt template creation');
  const eventType = `smoke.event.${runId}`;
  const automation = await admin('/automations', { method: 'POST', body: { name: `Smoke automation ${runId}`, triggerEvent: eventType, templateId: template.payload.template.id, enabled: true } });
  expectStatus(automation, 201, 'Automation creation');
  const automationRun = await admin(`/automations/${automation.payload.automation.id}/run`, { method: 'POST', headers: { 'x-request-id': `smoke-automation-${runId}` }, body: { smokeRun: runId } });
  expectStatus(automationRun, 200, 'Manual automation run');
  assert.equal(automationRun.payload.runs.length, 1);
  assert.equal(automationRun.payload.runs[0].status, 'completed');
  await admin(`/automations/${automation.payload.automation.id}`, { method: 'PATCH', body: { enabled: false } });
  const signedPayload = { id: `smoke-event-${runId}`, type: eventType, data: { runId, source: 'signed smoke test' } };
  const preview = await admin('/events/sign-preview', { method: 'POST', body: signedPayload });
  expectStatus(preview, 200, 'Signed event preview');
  const inbound = await api('/events/inbound', { method: 'POST', headers: { 'x-mediassist-signature': preview.payload.signature }, body: preview.payload.body });
  expectStatus(inbound, 202, 'Valid signed inbound event');
  const duplicateInbound = await api('/events/inbound', { method: 'POST', headers: { 'x-mediassist-signature': preview.payload.signature }, body: preview.payload.body });
  expectStatus(duplicateInbound, 202, 'Duplicate signed events are acknowledged');
  assert.equal(duplicateInbound.payload.duplicate, true);
  const conflictingPayload = { ...signedPayload, data: { runId: `different-${runId}`, source: 'signed smoke test' } };
  const conflictingPreview = await admin('/events/sign-preview', { method: 'POST', body: conflictingPayload });
  expectStatus(conflictingPreview, 200, 'Conflicting event signature preview');
  const conflictingInbound = await api('/events/inbound', { method: 'POST', headers: { 'x-mediassist-signature': conflictingPreview.payload.signature }, body: conflictingPreview.payload.body });
  expectStatus(conflictingInbound, 409, 'Reusing an event idempotency key with a different payload is rejected');
  const invalidInbound = await api('/events/inbound', { method: 'POST', headers: { 'x-mediassist-signature': 't=1,v1=invalid' }, body: signedPayload });
  expectStatus(invalidInbound, 401, 'Invalid signed inbound event');
  const automationRuns = await admin(`/automations/${automation.payload.automation.id}/runs`);
  expectStatus(automationRuns, 200, 'Automation run history');
  assert.equal(automationRuns.payload.runs.length, 1, 'Disabled automation must not run for subsequent matching events');
  pass('Prompt templates, automation runs and history, and signed inbound event validation');

  const unsafeEndpoint = await admin('/webhooks/endpoints', { method: 'POST', body: { url: 'http://example.com/callback', mode: 'ok' } });
  expectStatus(unsafeEndpoint, 400, 'Insecure external webhook URL is rejected');
  const endpoint = await admin('/webhooks/endpoints', { method: 'POST', body: { mode: '500' } });
  expectStatus(endpoint, 201, 'Create local signed webhook sandbox endpoint');
  assert.ok(endpoint.payload.secret.length >= 32);
  const endpointId = endpoint.payload.endpoint.id;
  const endpointList = await admin('/webhooks/endpoints');
  expectStatus(endpointList, 200, 'Webhook endpoint listing');
  const listedEndpoint = endpointList.payload.endpoints.find((item) => item.id === endpointId);
  assert.ok(listedEndpoint);
  assert.equal(Object.hasOwn(listedEndpoint, 'secret'), false);
  const pagedDeliveries = await admin('/webhooks/deliveries?page=1&limit=1');
  expectStatus(pagedDeliveries, 200, 'Webhook delivery pagination');
  assert.equal(pagedDeliveries.payload.pagination.limit, 1);
  assert.ok(pagedDeliveries.payload.deliveries.length <= 1);
  const bookingCorrelation = `smoke-booking-${runId}`;
  const available = await api(`/public/slots?date=${mockDate}`, { headers: { 'x-api-key': 'pk_test_mediassist', origin: 'http://localhost:5174', 'x-request-id': bookingCorrelation } });
  expectStatus(available, 200, 'Widget can fetch available booking slots');
  const slot = available.payload.slots[0];
  assert.ok(slot);
  assert.ok(available.payload.slots.length >= 2);
  const bookingInput = { slotId: slot.id, name: `Smoke Patient ${runId}`, email: `booking-${runId}@example.test`, phone: '+1 202 555 0199' };
  const bookingHeaders = { 'x-api-key': 'pk_test_mediassist', origin: 'http://localhost:5174', 'x-request-id': bookingCorrelation, 'idempotency-key': `smoke-booking-key-${runId}` };
  const booking = await api('/public/bookings', { method: 'POST', headers: bookingHeaders, body: bookingInput });
  expectStatus(booking, 201, 'Widget booking is sent through MediBook');
  assert.equal(booking.payload.booking.status, 'confirmed');
  const duplicateBooking = await api('/public/bookings', { method: 'POST', headers: bookingHeaders, body: bookingInput });
  expectStatus(duplicateBooking, 201, 'MediBook booking request is idempotent');
  assert.equal(duplicateBooking.payload.booking.id, booking.payload.booking.id);
  const secondBooking = await api('/public/bookings', { method: 'POST', headers: { ...bookingHeaders, 'idempotency-key': `smoke-booking-key-second-${runId}` }, body: { ...bookingInput, slotId: available.payload.slots[1].id, name: `Smoke Second ${runId}`, email: `booking-second-${runId}@example.test` } });
  expectStatus(secondBooking, 201, 'A second booking from the same widget trace receives a distinct idempotency key');
  assert.notEqual(secondBooking.payload.booking.id, booking.payload.booking.id);
  const emittedEvent = await api('/public/events/booking-created', { method: 'POST', headers: { 'x-api-key': 'pk_test_mediassist', origin: 'http://localhost:5174', 'x-request-id': bookingCorrelation }, body: { bookingId: booking.payload.booking.id } });
  expectStatus(emittedEvent, 202, 'Booking-created event is verified and accepted');
  const duplicateBookingEvent = await api('/public/events/booking-created', { method: 'POST', headers: { 'x-api-key': 'pk_test_mediassist', origin: 'http://localhost:5174', 'x-request-id': bookingCorrelation }, body: { bookingId: booking.payload.booking.id } });
  expectStatus(duplicateBookingEvent, 202, 'Duplicate booking-created event is acknowledged');
  assert.equal(duplicateBookingEvent.payload.duplicate, true);
  const bookings = await admin('/medibook/bookings');
  expectStatus(bookings, 200, 'Admin booking list proxy');
  assert.ok(bookings.payload.bookings.some((item) => item.id === booking.payload.booking.id));
  const bookingRuns = await waitUntil('booking-created automation run', () => admin(`/automations/booking-created-summary-v1/runs`), (result) => result.response.ok && result.payload.runs.some((item) => item.correlationId === bookingCorrelation));
  const automaticRun = bookingRuns.payload.runs.find((item) => item.correlationId === bookingCorrelation);
  assert.equal(automaticRun.status, 'completed');
  pass('Widget booking, MediBook idempotency, verified event, admin booking list, and automatic summary');

  const deliveriesForBooking = async () => {
    const result = await admin('/webhooks/deliveries');
    expectStatus(result, 200, 'Webhook delivery listing');
    return result.payload.deliveries.find((item) => item.correlationId === bookingCorrelation && item.eventType === 'booking.created' && item.endpointId === endpointId);
  };
  const failedDelivery = await waitUntil('initial webhook failure', deliveriesForBooking, (delivery) => delivery?.attempts >= 1, 60_000);
  assert.ok(['pending', 'failed'].includes(failedDelivery.status));
  assert.match(failedDelivery.lastError, /500/);
  const firstAttemptLogs = await waitUntil('initial webhook attempt log', () => admin(`/logs?type=webhook_attempt&correlationId=${bookingCorrelation}`), (result) => result.response.ok && result.payload.items.some((item) => item.status === 'failed' && item.httpStatus === 500), 10_000);
  expectStatus(firstAttemptLogs, 200, 'Webhook attempt trace');
  assert.ok(firstAttemptLogs.payload.items.some((item) => item.status === 'failed' && item.httpStatus === 500));
  const modeChange = await admin(`/webhooks/endpoints/${endpointId}`, { method: 'PATCH', body: { mode: 'ok' } });
  expectStatus(modeChange, 200, 'Switch sandbox receiver into success mode');
  let recoveryId = failedDelivery.id;
  if (failedDelivery.status === 'failed' || failedDelivery.attempts >= 4) {
    const retry = await admin(`/webhooks/deliveries/${failedDelivery.id}/replay`, { method: 'POST' });
    expectStatus(retry, 202, 'Replay a delivery that exhausted its retry policy');
    recoveryId = retry.payload.delivery.id;
  }
  const delivered = await waitUntil('webhook retry or replay succeeds', async () => {
    const result = await admin('/webhooks/deliveries');
    return result.payload.deliveries.find((item) => item.id === recoveryId);
  }, (delivery) => delivery?.status === 'delivered', 30_000);
  assert.ok(delivered.attempts >= 1);
  const replay = await admin(`/webhooks/deliveries/${delivered.id}/replay`, { method: 'POST' });
  expectStatus(replay, 202, 'Replay a prior webhook delivery');
  assert.equal(replay.payload.delivery.parentDeliveryId, delivered.id);
  const replayed = await waitUntil('replayed webhook delivery succeeds', async () => {
    const result = await admin('/webhooks/deliveries');
    return result.payload.deliveries.find((item) => item.id === replay.payload.delivery.id);
  }, (delivery) => delivery?.status === 'delivered', 15_000);
  assert.ok(replayed.attempts >= 1);
  const sendTest = await admin('/webhooks/send-test', { method: 'POST', body: { endpointId } });
  expectStatus(sendTest, 202, 'Queue a signed webhook test event');
  const testDelivery = await waitUntil('test webhook delivery', async () => {
    const result = await admin('/webhooks/deliveries');
    return result.payload.deliveries.find((item) => item.id === sendTest.payload.delivery.id);
  }, (delivery) => delivery?.status === 'delivered', 15_000);
  assert.ok(testDelivery.attempts >= 1);
  pass('HMAC-signed webhook delivery, failure retry, recovery, replay, and test event');

  const bookingLogs = await waitUntil('complete correlated booking trace', () => admin(`/logs?correlationId=${bookingCorrelation}&limit=100`), (result) => {
    if (!result.response.ok) return false;
    const types = new Set(result.payload.items.map((item) => item.type));
    return ['request', 'service_call', 'llm', 'event', 'webhook_attempt'].every((type) => types.has(type));
  }, 10_000);
  assert.ok(!JSON.stringify(bookingLogs.payload).includes(`booking-${runId}@example.test`), 'Logs must not contain the booking email');
  pass('Correlated request, MediBook, LLM, event, and webhook logs omit booking contact data');

  expectStatus(await admin('/auth/logout', { method: 'POST', headers: { authorization: 'Bearer invalid-token' } }), 204, 'Session logout clears the cookie even if an invalid bearer header is present');
  expectStatus(await api('/auth/me', { headers: { cookie: sessionCookie } }), 401, 'Logged-out cookie cannot be reused');
  pass('Logout invalidates the browser session');
  console.log('\nAll MediAssist integration smoke checks passed.');
}

main().catch((error) => {
  console.error('\nIntegration smoke test failed.');
  console.error(error);
  process.exitCode = 1;
});
