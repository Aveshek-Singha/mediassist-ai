import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { writeLog } from '../../db/mongo.js';
import { claimDueRecord, deleteRecordsBefore, deleteTerminalRecordsBefore, getRecord, putRecordIfLease } from '../../db/store.js';
import { nextAttemptDelay } from '../../lib/backoff.js';
import { signBody } from '../../lib/hmac.js';
import { decryptSecret } from '../../lib/secrets.js';
import { logger } from '../../lib/logger.js';
import { postWebhook, resolveWebhookTarget, safeWebhookFailure, WebhookPolicyError } from '../../lib/secureWebhook.js';
import { collection, type WebhookDelivery, type WebhookEndpoint } from '../models.js';

let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<boolean> | undefined;
let lastRetentionCleanupAt = 0;

export async function processOneDueDelivery(): Promise<boolean> {
  if (Date.now() - lastRetentionCleanupAt >= 60 * 60_000) {
    lastRetentionCleanupAt = Date.now();
    const now = Date.now();
    const cleanup = [
      deleteRecordsBefore(collection.eventReceipts, 'createdAt', new Date(now - env.EVENT_RECEIPT_RETENTION_DAYS * 86_400_000)),
      deleteTerminalRecordsBefore(collection.deliveries, new Date(now - env.WEBHOOK_DELIVERY_RETENTION_DAYS * 86_400_000), ['delivered', 'failed']),
      deleteRecordsBefore(collection.runs, 'createdAt', new Date(now - env.AUTOMATION_RUN_RETENTION_DAYS * 86_400_000)),
      ...(env.CLINICAL_NOTE_RETENTION_DAYS > 0 ? [deleteRecordsBefore(collection.notes, 'createdAt', new Date(now - env.CLINICAL_NOTE_RETENTION_DAYS * 86_400_000))] : [])
    ];
    await Promise.all(cleanup).catch((error) => logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'record retention cleanup failed'));
  }
  const workerId = `webhook-${process.pid}`;
  const leaseToken = randomUUID();
  const due = await claimDueRecord<WebhookDelivery>(collection.deliveries, new Date(), workerId, leaseToken, 60_000);
  if (!due) return false;

  const endpoint = await getRecord<WebhookEndpoint>(collection.endpoints, due.endpointId);
  if (!endpoint?.enabled) {
    due.status = 'failed';
    due.lastError = 'Webhook endpoint is missing or disabled.';
    due.updatedAt = new Date().toISOString();
    clearLease(due);
    await putRecordIfLease(collection.deliveries, due, leaseToken);
    return true;
  }

  const body = JSON.stringify(due.payload);
  let targetUrl = endpoint.url;
  const isInternalSandbox = isInternalSandboxEndpoint(endpoint);
  if (isInternalSandbox) {
    const target = new URL(endpoint.url);
    target.searchParams.set('mode', endpoint.mode);
    targetUrl = target.toString();
  }
  const started = Date.now();
  let status = 0;
  let signature = '';
  let errorText: string | undefined;
  let permanentFailure = false;
  try {
    signature = signBody(body, decryptSecret(endpoint.secret));
    const target = await resolveWebhookTarget(targetUrl, isInternalSandbox && env.NODE_ENV !== 'production');
    status = await postWebhook(target, body, signature, due.correlationId, 3000);
    if (status < 200 || status >= 300) errorText = `Receiver returned ${status}.`;
  } catch (error) {
    permanentFailure = error instanceof WebhookPolicyError || (error instanceof Error && error.message.includes('Stored webhook secret'));
    errorText = permanentFailure ? 'Webhook destination failed security validation.' : safeWebhookFailure(error);
  }

  due.attempts += 1;
  due.updatedAt = new Date().toISOString();
  const attemptLog = {
    type: 'webhook_attempt' as const,
    correlationId: due.correlationId,
    ts: due.updatedAt,
    deliveryId: due.id,
    endpointId: endpoint.id,
    attempt: due.attempts,
    httpStatus: status || undefined,
    status: errorText ? 'failed' : 'delivered',
    durationMs: Date.now() - started,
    error: errorText,
    signaturePrefix: signature.slice(0, 10)
  };
  if (!errorText) {
    due.status = 'delivered';
    due.nextAttemptAt = undefined;
    due.lastError = undefined;
  } else {
    const delay = permanentFailure ? null : nextAttemptDelay(due.attempts, env.WEBHOOK_BACKOFF_SCALE);
    if (delay === null) {
      due.status = 'failed';
      due.nextAttemptAt = undefined;
      due.lastError = errorText;
    } else {
      due.status = 'pending';
      due.nextAttemptAt = new Date(Date.now() + delay).toISOString();
      due.lastError = errorText;
    }
  }
  clearLease(due);
  const persisted = await putRecordIfLease(collection.deliveries, due, leaseToken);
  if (!persisted) {
    logger.warn({ correlationId: due.correlationId, deliveryId: due.id }, 'webhook delivery lease expired before state update');
    return true;
  }
  await writeLog(attemptLog).catch((error) => logger.error({ correlationId: due.correlationId, deliveryId: due.id, errorType: error instanceof Error ? error.name : 'unknown' }, 'webhook attempt log write failed'));
  return true;
}

export function startDeliveryWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = processOneDueDelivery()
      .catch((error) => { logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'webhook worker failed'); return false; })
      .finally(() => { inFlight = undefined; });
  }, env.WEBHOOK_POLL_MS);
  timer.unref();
}

export async function stopDeliveryWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await inFlight;
}

function clearLease(delivery: WebhookDelivery): void {
  delete delivery.leaseOwner;
  delete delivery.leaseToken;
  delete delivery.leaseUntil;
}

function isInternalSandboxEndpoint(endpoint: WebhookEndpoint): boolean {
  try {
    const target = new URL(endpoint.url);
    const publicBase = new URL(env.PUBLIC_BASE_URL);
    return target.origin === publicBase.origin && target.pathname === `/sandbox/receiver/${endpoint.id}`;
  } catch {
    return false;
  }
}

export function createDelivery(endpointId: string, eventType: string, payload: unknown, correlationId: string, parentDeliveryId?: string, deliveryId?: string): WebhookDelivery {
  const now = new Date().toISOString();
  return {
    id: deliveryId ?? randomUUID(), endpointId, eventType, payload, status: 'pending', attempts: 0,
    nextAttemptAt: now, correlationId, parentDeliveryId, createdAt: now, updatedAt: now
  };
}
