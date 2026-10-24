import { createHash, createHmac, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { writeLog } from '../../db/mongo.js';
import { claimDueRecord, getRecord, insertRecordIfAbsent, listRecords, putRecord, putRecordIfLease } from '../../db/store.js';
import { logger } from '../../lib/logger.js';
import { redactPhi } from '../../lib/redact.js';
import { collection, type Automation, type AutomationRun, type EventReceipt, type PromptTemplate, type WebhookEndpoint } from '../models.js';
import { summarizeNote } from '../notes/llm.js';
import { createDelivery } from '../webhooks/worker.js';

export async function processEvent(eventType: string, payload: Record<string, unknown>, correlationId: string, idempotencyKey?: string): Promise<{ duplicate: boolean; pending?: boolean }> {
  if (!idempotencyKey) {
    await processEventWork(eventType, payload, correlationId);
    return { duplicate: false };
  }

  const receiptId = createHmac('sha256', env.JWT_SECRET).update(eventType).update('\0').update(idempotencyKey).digest('hex');
  const requestHash = createHmac('sha256', env.JWT_SECRET).update(JSON.stringify(payload)).digest('hex');
  const now = new Date().toISOString();
  const insertion = await insertRecordIfAbsent<EventReceipt>(collection.eventReceipts, {
    id: receiptId, eventType, requestHash, status: 'pending', correlationId, nextAttemptAt: now, createdAt: now
  });
  const receipt = insertion.record;
  if (!insertion.inserted && receipt.requestHash && receipt.requestHash !== requestHash) {
    const conflict = new Error('This event idempotency key was already used with a different payload.') as Error & { statusCode: number };
    conflict.statusCode = 409;
    throw conflict;
  }
  if (!insertion.inserted && !receipt.requestHash) {
    if (receipt.status === 'completed') return { duplicate: true };
    const conflict = new Error('This event key was created by an older server and must be retried with a new idempotency key.') as Error & { statusCode: number };
    conflict.statusCode = 409;
    throw conflict;
  }
  if (!insertion.inserted && receipt.status === 'completed') return { duplicate: true };
  if (!insertion.inserted && receipt.status === 'failed') {
    receipt.status = 'pending';
    receipt.nextAttemptAt = now;
    delete receipt.error;
    await putRecord(collection.eventReceipts, receipt);
  }

  const leaseToken = randomUUID();
  const claimed = await claimDueRecord<EventReceipt>(collection.eventReceipts, new Date(), `event-${process.pid}`, leaseToken, 5 * 60_000, receiptId);
  if (!claimed) return { duplicate: true, pending: true };
  try {
    await processEventWork(eventType, payload, claimed.correlationId, receiptId);
    claimed.status = 'completed';
    claimed.completedAt = new Date().toISOString();
    clearReceiptLease(claimed);
    const saved = await putRecordIfLease(collection.eventReceipts, claimed, leaseToken);
    if (!saved) throw new Error('Event processing lease expired before completion was recorded.');
    return { duplicate: false };
  } catch (error) {
    claimed.status = 'failed';
    claimed.error = 'Event processing failed; the source may retry with the same idempotency key.';
    clearReceiptLease(claimed);
    await putRecordIfLease(collection.eventReceipts, claimed, leaseToken);
    throw error;
  }
}

function clearReceiptLease(receipt: EventReceipt): void {
  delete receipt.leaseOwner;
  delete receipt.leaseToken;
  delete receipt.leaseUntil;
}

async function processEventWork(eventType: string, payload: Record<string, unknown>, correlationId: string, stableEventId?: string): Promise<void> {
  await writeLog({ type: 'event', correlationId, ts: new Date().toISOString(), eventType, status: 'received' });
  const automations = (await listRecords<Automation>(collection.automations)).filter((item) => item.enabled && item.triggerEvent === eventType);
  let automationFailed = false;
  for (const automation of automations) {
    const runId = stableEventId
      ? createHash('sha256').update(`${stableEventId}:${automation.id}`).digest('hex')
      : randomUUID();
    const priorRun = stableEventId ? await getRecord<AutomationRun>(collection.runs, runId) : null;
    if (priorRun?.status === 'completed') continue;
    const run: AutomationRun = { id: runId, automationId: automation.id, triggerEvent: eventType, status: 'completed', correlationId, createdAt: new Date().toISOString() };
    try {
      const template = await getRecord<PromptTemplate>(collection.templates, automation.templateId);
      const prompt = template?.body ?? 'Summarize the event in concise JSON.';
      const safePayload = sanitizeEventPayload(payload);
      const result = await summarizeNote(`Event type: ${eventType}\nEvent data: ${JSON.stringify(safePayload)}`, prompt, correlationId);
      run.result = result.summary;
    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : 'Automation failed.';
      automationFailed = true;
      logger.warn({ correlationId, automationId: automation.id, errorType: error instanceof Error ? error.name : 'unknown' }, 'event automation failed');
    }
    await putRecord(collection.runs, run);
  }

  const endpoints = (await listRecords<WebhookEndpoint>(collection.endpoints)).filter((endpoint) => endpoint.enabled);
  for (const endpoint of endpoints) {
    const deliveryId = stableEventId
      ? createHash('sha256').update(`${stableEventId}:${endpoint.id}`).digest('hex')
      : undefined;
    const delivery = createDelivery(endpoint.id, eventType, { id: randomUUID(), type: eventType, data: payload, createdAt: new Date().toISOString() }, correlationId, undefined, deliveryId);
    if (stableEventId) await insertRecordIfAbsent(collection.deliveries, delivery);
    else await putRecord(collection.deliveries, delivery);
  }
  if (automationFailed) throw new Error('One or more event automations failed.');
}

const sensitiveEventKey = /(patient|name|surname|email|phone|mobile|address|birth|dob|ssn|mrn|medical.?record|note|free.?text|diagnos|symptom|medication)/i;

export function sanitizeEventPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactPhi(value).slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 100).map(sanitizeEventPayload);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !sensitiveEventKey.test(key))
    .slice(0, 100)
    .map(([key, nested]) => [key, sanitizeEventPayload(nested)]));
}
