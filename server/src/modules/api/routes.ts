import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { mongoHealth, queryLogs } from '../../db/mongo.js';
import { claimDueRecord, findRecordByField, getRecord, insertRecordIfUniqueField, listRecords, listRecordsPage, listRecordsPageByField, putRecord, putRecordIfLease, storageHealth, storeMode, updateUserAccess } from '../../db/store.js';
import { asyncRoute } from '../../lib/asyncRoute.js';
import { verifyBody } from '../../lib/hmac.js';
import { redactPhi } from '../../lib/redact.js';
import { encryptSecret, decryptSecret } from '../../lib/secrets.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { requirePublicKey } from '../../middleware/publicKey.js';
import { mediBook } from '../medibook/client.js';
import { collection, type ApiKey, type Automation, type AutomationRun, type PromptTemplate, type VisitNote, type WebhookDelivery, type WebhookEndpoint } from '../models.js';
import { noteInputSchema, soapSummarySchema } from '../notes/schemas.js';
import { summarizeNote } from '../notes/llm.js';
import { processEvent } from '../events/service.js';
import { createDelivery } from '../webhooks/worker.js';
import { resolveWebhookTarget, WebhookPolicyError } from '../../lib/secureWebhook.js';
import { authRouter, createUser } from '../auth/routes.js';
import { rateLimit } from '../../middleware/rateLimit.js';

export const apiRouter = Router();
const publicRateLimit = rateLimit({ prefix: 'widget-public', windowMs: 60_000, limit: 60 });
const noteRateLimit = rateLimit({ prefix: 'notes-summarize', windowMs: 60_000, limit: 10, key: (request) => request.user?.id ?? request.ip ?? 'unknown' });
const inboundEventRateLimit = rateLimit({ prefix: 'inbound-events', windowMs: 60_000, limit: 120 });
const originListSchema = z.array(z.string().url()).min(1).max(30).transform((origins) => [...new Set(origins.map((origin) => new URL(origin).origin))]);

apiRouter.get('/health/live', (_req, res) => res.json({ status: 'ok' }));

apiRouter.get('/health/ready', asyncRoute(async (_req, res) => {
  const [database, logs] = await Promise.all([storageHealth(), mongoHealth()]);
  const ok = database.ok && logs.ok;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ready' : 'not_ready', timestamp: new Date().toISOString(),
    database: { mode: storeMode, ok: database.ok }, logs: { mode: logs.mode, ok: logs.ok }
  });
}));

apiRouter.get('/health', asyncRoute(async (_req, res) => {
  const [database, logs] = await Promise.all([storageHealth(), mongoHealth()]);
  const ok = database.ok && logs.ok;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded', timestamp: new Date().toISOString(),
    database: { mode: storeMode, ok: database.ok }, logs: { mode: logs.mode, ok: logs.ok }
  });
}));

apiRouter.get('/widget.js', asyncRoute(async (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', env.NODE_ENV === 'production' ? 'public, max-age=300' : 'no-cache');
  res.type('application/javascript');
  res.sendFile(resolve(process.cwd(), 'public/widget.js'));
}));

apiRouter.get('/openapi.json', (_req, res) => res.json({
  openapi: '3.0.3', info: { title: 'MediAssist API', version: '1.0.0' }, servers: [{ url: env.PUBLIC_BASE_URL }],
  paths: {
    '/health': { get: { summary: 'Storage and service health' } },
    '/auth/login': { post: { summary: 'Create a browser session or begin administrator MFA verification' } },
    '/auth/mfa/setup': { post: { summary: 'Prepare a TOTP authenticator setup', security: [{ bearerAuth: [] }] } },
    '/auth/mfa/enable': { post: { summary: 'Enable TOTP and create recovery codes', security: [{ bearerAuth: [] }] } },
    '/auth/mfa/verify': { post: { summary: 'Verify TOTP or consume a recovery code', security: [{ bearerAuth: [] }] } },
    '/auth/mfa/recovery-codes': { post: { summary: 'Replace administrator recovery codes', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/notes': { get: { summary: 'List visit notes with page and limit parameters', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/notes/summarize': { post: { summary: 'Redact and summarize a visit note', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/medibook/slots': { get: { summary: 'Fetch booking slots from MediBook', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/webhooks/send-test': { post: { summary: 'Queue a signed test webhook', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/webhooks/deliveries': { get: { summary: 'List webhook deliveries with page and limit parameters', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/logs': { get: { summary: 'Search correlated service logs', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/api-keys': { get: { summary: 'List widget key hints', security: [{ bearerAuth: [] }, { cookieAuth: [] }] }, post: { summary: 'Create a widget key', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/users': { get: { summary: 'List team users; admin only', security: [{ bearerAuth: [] }, { cookieAuth: [] }] }, post: { summary: 'Create a team user; admin only', security: [{ bearerAuth: [] }, { cookieAuth: [] }] } },
    '/public/slots': { get: { summary: 'Widget booking slots', security: [{ publicKey: [] }] } },
    '/public/bookings': { post: { summary: 'Create a widget booking', security: [{ publicKey: [] }] } }
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, cookieAuth: { type: 'apiKey', in: 'cookie', name: '__Host-mediassist_session' }, publicKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } }
}));

apiRouter.get('/docs', (_req, res) => res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MediAssist API</title></head><body><main><h1>MediAssist API</h1><p>OpenAPI 3.0 contract for the running service.</p><p><a href="/openapi.json">View or download the OpenAPI document</a></p></main></body></html>`));

apiRouter.use('/auth', authRouter);

const protectedApi = Router();
protectedApi.use(requireAuth);

protectedApi.post('/notes/summarize', noteRateLimit, asyncRoute(async (req, res) => {
  const { note } = noteInputSchema.parse(req.body);
  const idempotencyKey = req.header('idempotency-key')?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) return res.status(400).json({ error: 'Send an Idempotency-Key between 8 and 128 characters.' });
  const scope = createHmac('sha256', env.JWT_SECRET).update(req.user!.id).update('\0').update(idempotencyKey).digest('hex');
  const requestHash = createHmac('sha256', env.JWT_SECRET).update(note).digest('hex');
  let existing = await findRecordByField<VisitNote>(collection.notes, 'idempotencyScope', scope);
  if (!existing) {
    const candidate: VisitNote = {
      id: randomUUID(), redactedText: redactPhi(note), rawText: env.STORE_RAW_NOTES === 'true' ? note : undefined,
      status: 'pending', idempotencyKey: scope, idempotencyScope: scope, requestHash,
      correlationId: req.correlationId, createdAt: new Date().toISOString()
    };
    const inserted = await insertRecordIfUniqueField(collection.notes, candidate, 'idempotencyScope');
    existing = inserted.record;
  }
  if (existing.requestHash && existing.requestHash !== requestHash) return res.status(409).json({ error: 'This Idempotency-Key was already used with a different note.' });
  if (existing.status === 'completed') return res.json({ note: safeNote(existing), redactedText: existing.redactedText, reused: true });
  if (existing.status === 'failed') return res.status(502).json({ note: safeNote(existing), redactedText: existing.redactedText, reused: true });

  const leaseToken = randomUUID();
  const claimed = await claimDueRecord<VisitNote>(collection.notes, new Date(), `note-${process.pid}`, leaseToken, 5 * 60_000, existing.id);
  if (!claimed) return res.status(202).json({ note: safeNote(existing), redactedText: existing.redactedText, reused: true, pending: true });
  const result = await createSummary(claimed, leaseToken);
  return res.status(result.note.status === 'completed' ? 200 : 502).json(result);
}));

async function createSummary(visitNote: VisitNote, leaseToken: string): Promise<{ note: Omit<VisitNote, 'rawText'>; redactedText: string }> {
  try {
    const activeTemplate = (await listRecords<PromptTemplate>(collection.templates)).find((template) => template.active);
    const prompt = activeTemplate?.body ?? 'Summarize this clinical visit into SOAP JSON. Do not invent facts.';
    const started = Date.now();
    const result = await summarizeNote(visitNote.redactedText, prompt, visitNote.correlationId);
    visitNote.summary = soapSummarySchema.parse(result.summary);
    visitNote.status = 'completed';
    visitNote.provider = result.provider;
    visitNote.model = result.model;
    visitNote.tokensIn = result.tokensIn;
    visitNote.tokensOut = result.tokensOut;
    visitNote.latencyMs = Date.now() - started;
  } catch (error) {
    visitNote.status = 'failed';
    visitNote.error = error instanceof Error ? error.message : 'Summarization failed.';
  }
  delete visitNote.leaseOwner;
  delete visitNote.leaseToken;
  delete visitNote.leaseUntil;
  const saved = await putRecordIfLease(collection.notes, visitNote, leaseToken);
  if (!saved) throw new Error('The note processing lease expired before the result was saved. Retry with the same idempotency key.');
  return { note: safeNote(visitNote), redactedText: visitNote.redactedText };
}

function safeNote(note: VisitNote): Omit<VisitNote, 'rawText' | 'leaseOwner' | 'leaseToken' | 'leaseUntil'> {
  const { rawText: _raw, leaseOwner: _owner, leaseToken: _token, leaseUntil: _until, ...safe } = note;
  return safe;
}

protectedApi.get('/notes', asyncRoute(async (req, res) => {
  const input = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  const result = await listRecordsPage<VisitNote>(collection.notes, input.page, input.limit);
  res.json({ notes: result.items.map(({ rawText: _raw, ...note }) => note), pagination: { page: result.page, limit: result.limit, total: result.total, pages: result.pages } });
}));

protectedApi.get('/notes/:id', asyncRoute(async (req, res) => {
  const note = await getRecord<VisitNote>(collection.notes, req.params.id);
  if (!note) return res.status(404).json({ error: 'Visit note not found.' });
  const { rawText: _raw, ...safeNote } = note;
  res.json({ note: safeNote });
}));

protectedApi.use(['/templates', '/automations', '/webhooks', '/logs', '/api-keys', '/users'], requireAdmin);

protectedApi.get('/users', asyncRoute(async (_req, res) => {
  const users = (await listRecords<import('../models.js').User>(collection.users))
    .map(({ id, email, role, active, createdAt }) => ({ id, email, role, active: active !== false, createdAt }))
    .sort((a, b) => a.email.localeCompare(b.email));
  res.json({ users });
}));
protectedApi.post('/users', asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(256), role: z.enum(['admin', 'staff']).default('staff') }).parse(req.body);
  if (await findRecordByField(collection.users, 'email', input.email.toLowerCase())) return res.status(409).json({ error: 'A user with this email already exists.' });
  try {
    const user = await createUser(input);
    res.status(201).json({ user: { id: user.id, email: user.email, role: user.role, active: user.active !== false, createdAt: user.createdAt } });
  } catch (error) {
    if (error instanceof Error && /already exists/i.test(error.message)) return res.status(409).json({ error: 'A user with this email already exists.' });
    throw error;
  }
}));
protectedApi.patch('/users/:id', asyncRoute(async (req, res) => {
  const input = z.object({ role: z.enum(['admin', 'staff']).optional(), active: z.boolean().optional() }).refine((value) => value.role !== undefined || value.active !== undefined).parse(req.body);
  const result = await updateUserAccess(req.params.id, input);
  if (result.result === 'not_found' || !result.record) return res.status(404).json({ error: 'User not found.' });
  if (result.result === 'last_admin') return res.status(409).json({ error: 'The last active administrator cannot be demoted or disabled.' });
  const user = result.record as import('../models.js').User;
  res.json({ user: { id: user.id, email: user.email, role: user.role, active: user.active !== false, createdAt: user.createdAt } });
}));

protectedApi.get('/templates', asyncRoute(async (_req, res) => res.json({ templates: await listRecords<PromptTemplate>(collection.templates) })));
protectedApi.post('/templates', asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().min(2).max(100), body: z.string().min(10).max(5000), active: z.boolean().default(false) }).parse(req.body);
  const existing = await listRecords<PromptTemplate>(collection.templates);
  const template: PromptTemplate = { id: randomUUID(), name: input.name, body: input.body, active: input.active, version: existing.filter((item) => item.name === input.name).length + 1, createdAt: new Date().toISOString() };
  if (input.active) for (const prior of existing.filter((item) => item.active)) { prior.active = false; await putRecord(collection.templates, prior); }
  await putRecord(collection.templates, template);
  res.status(201).json({ template });
}));

protectedApi.get('/automations', asyncRoute(async (_req, res) => res.json({ automations: await listRecords<Automation>(collection.automations) })));
protectedApi.post('/automations', asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().min(2).max(100), triggerEvent: z.string().min(3).max(100), templateId: z.string(), enabled: z.boolean().default(true) }).parse(req.body);
  const template = await getRecord<PromptTemplate>(collection.templates, input.templateId);
  if (!template) return res.status(400).json({ error: 'Choose an existing prompt template.' });
  const automation: Automation = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
  await putRecord(collection.automations, automation);
  res.status(201).json({ automation });
}));
protectedApi.patch('/automations/:id', asyncRoute(async (req, res) => {
  const automation = await getRecord<Automation>(collection.automations, req.params.id);
  if (!automation) return res.status(404).json({ error: 'Automation not found.' });
  const input = z.object({ name: z.string().min(2).max(100).optional(), enabled: z.boolean().optional(), templateId: z.string().optional(), triggerEvent: z.string().min(3).max(100).optional() }).parse(req.body);
  Object.assign(automation, input);
  await putRecord(collection.automations, automation);
  res.json({ automation });
}));
protectedApi.post('/automations/:id/run', asyncRoute(async (req, res) => {
  const automation = await getRecord<Automation>(collection.automations, req.params.id);
  if (!automation) return res.status(404).json({ error: 'Automation not found.' });
  await processEvent(automation.triggerEvent, { source: 'manual', automationId: automation.id, ...(typeof req.body === 'object' ? req.body : {}) }, req.correlationId);
  const runs = (await listRecords<AutomationRun>(collection.runs)).filter((run) => run.automationId === automation.id && run.correlationId === req.correlationId);
  res.json({ runs });
}));
protectedApi.get('/automations/:id/runs', asyncRoute(async (req, res) => {
  const input = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(3) }).parse(req.query);
  const result = await listRecordsPageByField<AutomationRun>(collection.runs, 'automationId', req.params.id, input.page, input.limit);
  res.json({ runs: result.items, pagination: { page: result.page, limit: result.limit, total: result.total, pages: result.pages } });
}));

protectedApi.get('/webhooks/endpoints', asyncRoute(async (_req, res) => {
  const endpoints = (await listRecords<WebhookEndpoint>(collection.endpoints)).map(({ secret: _secret, ...endpoint }) => endpoint);
  res.json({ endpoints });
}));
protectedApi.post('/webhooks/endpoints', asyncRoute(async (req, res) => {
  const input = z.object({ url: z.string().url().optional(), mode: z.enum(['ok', '500', 'timeout', 'slow', 'badsig']).default('500') }).parse(req.body ?? {});
  if (env.NODE_ENV === 'production' && !input.url) return res.status(400).json({ error: 'Configure a public HTTPS webhook URL in production.' });
  const id = randomUUID();
  const internalUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/sandbox/receiver/${id}`;
  if (input.url) {
    try {
      await resolveWebhookTarget(input.url);
    } catch (error) {
      const message = error instanceof WebhookPolicyError ? error.message : 'Webhook host could not be resolved.';
      return res.status(400).json({ error: message });
    }
  }
  const secret = randomBytes(32).toString('hex');
  const endpoint: WebhookEndpoint = { id, url: input.url ?? internalUrl, secret: encryptSecret(secret), enabled: true, mode: env.NODE_ENV === 'production' ? 'ok' : input.mode, createdAt: new Date().toISOString() };
  await putRecord(collection.endpoints, endpoint);
  res.status(201).json({ endpoint: { id: endpoint.id, url: endpoint.url, mode: endpoint.mode, enabled: endpoint.enabled, createdAt: endpoint.createdAt }, secret });
}));
protectedApi.patch('/webhooks/endpoints/:id', asyncRoute(async (req, res) => {
  const endpoint = await getRecord<WebhookEndpoint>(collection.endpoints, req.params.id);
  if (!endpoint) return res.status(404).json({ error: 'Webhook endpoint not found.' });
  const input = env.NODE_ENV === 'production'
    ? z.object({ enabled: z.boolean().optional() }).parse(req.body)
    : z.object({ enabled: z.boolean().optional(), mode: z.enum(['ok', '500', 'timeout', 'slow', 'badsig']).optional() }).parse(req.body);
  Object.assign(endpoint, input);
  await putRecord(collection.endpoints, endpoint);
  const { secret: _secret, ...safeEndpoint } = endpoint;
  res.json({ endpoint: safeEndpoint });
}));
protectedApi.post('/webhooks/send-test', asyncRoute(async (req, res) => {
  const input = z.object({ endpointId: z.string().optional() }).parse(req.body ?? {});
  let endpoint = input.endpointId ? await getRecord<WebhookEndpoint>(collection.endpoints, input.endpointId) : undefined;
  if (!endpoint) endpoint = (await listRecords<WebhookEndpoint>(collection.endpoints)).find((item) => item.enabled);
  if (!endpoint) return res.status(400).json({ error: 'Create an enabled webhook endpoint first.' });
  const delivery = createDelivery(endpoint.id, 'webhook.test', { id: randomUUID(), type: 'webhook.test', data: { message: 'MediAssist sandbox test', sentAt: new Date().toISOString() } }, req.correlationId);
  await putRecord(collection.deliveries, delivery);
  res.status(202).json({ delivery });
}));
protectedApi.get('/webhooks/deliveries', asyncRoute(async (req, res) => {
  const input = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
  const result = await listRecordsPage<WebhookDelivery>(collection.deliveries, input.page, input.limit);
  res.json({ deliveries: result.items, pagination: { page: result.page, limit: result.limit, total: result.total, pages: result.pages } });
}));
protectedApi.post('/webhooks/deliveries/:id/replay', asyncRoute(async (req, res) => {
  const original = await getRecord<WebhookDelivery>(collection.deliveries, req.params.id);
  if (!original) return res.status(404).json({ error: 'Webhook delivery not found.' });
  const replay = createDelivery(original.endpointId, original.eventType, original.payload, req.correlationId, original.id);
  await putRecord(collection.deliveries, replay);
  res.status(202).json({ delivery: replay });
}));

protectedApi.get('/logs', asyncRoute(async (req, res) => {
  const input = z.object({ type: z.string().optional(), status: z.string().optional(), correlationId: z.string().optional(), from: z.string().optional(), to: z.string().optional(), page: z.coerce.number().int().min(1).max(1_000_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  res.json(await queryLogs(input));
}));

protectedApi.get('/medibook/slots', asyncRoute(async (req, res) => {
  const date = z.string().date().parse(req.query.date);
  res.json(await mediBook.slots(date, req.correlationId));
}));
protectedApi.get('/medibook/bookings', asyncRoute(async (req, res) => {
  res.json(await mediBook.bookings(req.correlationId));
}));
protectedApi.post('/medibook/bookings', asyncRoute(async (req, res) => {
  const input = z.object({ slotId: z.string(), name: z.string().min(2).max(120), email: z.string().email(), phone: z.string().max(40).optional() }).parse(req.body);
  res.status(201).json(await mediBook.createBooking(input, req.correlationId, req.header('idempotency-key')?.trim() || req.correlationId));
}));

protectedApi.get('/api-keys', asyncRoute(async (_req, res) => {
  const keys = (await listRecords<ApiKey>(collection.apiKeys)).map(({ publicKey, ...key }) => ({ ...key, keyHint: `${publicKey.slice(0, 7)}…${publicKey.slice(-4)}` }));
  res.json({ keys });
}));
protectedApi.post('/api-keys', asyncRoute(async (req, res) => {
  const input = z.object({ clinicId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), allowedOrigins: originListSchema }).parse(req.body);
  const publicKey = `pk_live_${randomBytes(24).toString('hex')}`;
  const key: ApiKey = { id: randomUUID(), publicKey, clinicId: input.clinicId, allowedOrigins: input.allowedOrigins, enabled: true, createdAt: new Date().toISOString() };
  await putRecord(collection.apiKeys, key);
  res.status(201).json({ key: { id: key.id, clinicId: key.clinicId, allowedOrigins: key.allowedOrigins, enabled: key.enabled, createdAt: key.createdAt }, publicKey });
}));
protectedApi.patch('/api-keys/:id', asyncRoute(async (req, res) => {
  const key = await getRecord<ApiKey>(collection.apiKeys, req.params.id);
  if (!key) return res.status(404).json({ error: 'Public key not found.' });
  const input = z.object({ enabled: z.boolean().optional(), allowedOrigins: originListSchema.optional() }).parse(req.body);
  Object.assign(key, input);
  await putRecord(collection.apiKeys, key);
  res.json({ key: { clinicId: key.clinicId, allowedOrigins: key.allowedOrigins, enabled: key.enabled, createdAt: key.createdAt } });
}));

const publicApi = Router();
publicApi.use(publicRateLimit, requirePublicKey);
publicApi.get('/slots', asyncRoute(async (req, res) => {
  const date = z.string().date().parse(req.query.date);
  res.json(await mediBook.slots(date, req.correlationId));
}));
publicApi.post('/bookings', asyncRoute(async (req, res) => {
  const input = z.object({ slotId: z.string(), name: z.string().min(2).max(120), email: z.string().email(), phone: z.string().max(40).optional() }).parse(req.body);
  res.status(201).json(await mediBook.createBooking(input, req.correlationId, req.header('idempotency-key')?.trim() || req.correlationId));
}));
publicApi.post('/events/booking-created', asyncRoute(async (req, res) => {
  const input = z.object({ bookingId: z.string().min(1) }).parse(req.body);
  const { booking } = await mediBook.getBooking(input.bookingId, req.correlationId);
  const result = await processEvent('booking.created', { bookingId: booking.id, slot: booking.slot, status: booking.status }, req.correlationId, `booking:${booking.id}`);
  res.status(202).json({ accepted: true, ...result, correlationId: req.correlationId });
}));
apiRouter.use('/public', publicApi);

apiRouter.post('/events/inbound', inboundEventRateLimit, asyncRoute(async (req, res) => {
  const body = req.rawBody ?? JSON.stringify(req.body);
  if (!verifyBody(body, req.header('x-mediassist-signature'), env.MEDIBOOK_WEBHOOK_SECRET)) return res.status(401).json({ error: 'Invalid event signature.' });
  const input = z.object({ id: z.string().min(1).max(128).optional(), type: z.string().min(1).max(100), data: z.record(z.string(), z.unknown()) }).parse(req.body);
  const suppliedKey = req.header('idempotency-key')?.trim();
  if (suppliedKey && (suppliedKey.length < 8 || suppliedKey.length > 128)) return res.status(400).json({ error: 'Idempotency-Key must be between 8 and 128 characters.' });
  const eventKey = suppliedKey ?? input.id ?? createHash('sha256').update(body).digest('hex');
  const result = await processEvent(input.type, input.data, req.correlationId, eventKey);
  res.status(202).json({ accepted: true, ...result, correlationId: req.correlationId });
}));

apiRouter.post('/events/simulate', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  if (env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found.' });
  const input = z.object({ type: z.string().default('booking.created'), data: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
  await processEvent(input.type, input.data ?? { bookingId: `demo-${randomUUID()}`, source: 'dashboard simulation' }, req.correlationId);
  res.status(202).json({ accepted: true, correlationId: req.correlationId });
}));

apiRouter.post('/sandbox/receiver/:endpointId', asyncRoute(async (req, res) => {
  if (env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found.' });
  const endpoint = await getRecord<WebhookEndpoint>(collection.endpoints, req.params.endpointId);
  if (!endpoint) return res.status(404).json({ error: 'Unknown sandbox endpoint.' });
  const body = req.rawBody ?? JSON.stringify(req.body);
  const signature = req.header('x-mediassist-signature');
  if (!verifyBody(body, signature, decryptSecret(endpoint.secret))) return res.status(401).json({ error: 'Signature verification failed.' });
  const mode = z.enum(['ok', '500', 'timeout', 'slow', 'badsig']).catch('ok').parse(req.query.mode);
  if (mode === 'badsig') return res.status(401).json({ error: 'Sandbox rejected the intentionally bad signature.' });
  if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 10_000));
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 1_200));
  if (mode === '500') return res.status(500).json({ received: true, simulated: 'server-error' });
  res.json({ received: true, verified: true, correlationId: req.correlationId });
}));

apiRouter.post('/events/sign-preview', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  if (env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found.' });
  const body = JSON.stringify(req.body ?? {});
  const { signBody } = await import('../../lib/hmac.js');
  res.json({ signature: signBody(body, env.MEDIBOOK_WEBHOOK_SECRET), body });
}));

apiRouter.use(protectedApi);
