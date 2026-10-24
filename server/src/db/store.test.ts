import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { env } from '../config/env.js';

let store: typeof import('./store.js');
let testDirectory: string;

before(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'mediassist-store-test-'));
  env.DATA_DIR = testDirectory;
  store = await import('./store.js');
  await store.initStore();
});

after(async () => {
  await store.closeStore();
  await rm(testDirectory, { recursive: true, force: true });
});

test('record insert-if-absent and unique-field operations are atomic in the local adapter', async () => {
  const first = await store.insertRecordIfAbsent('test_records', { id: 'same-id', value: 'first' });
  const duplicate = await store.insertRecordIfAbsent('test_records', { id: 'same-id', value: 'second' });
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.record.value, 'first');

  const uniqueOne = { id: 'unique-one', idempotencyScope: 'shared-key', requestHash: 'hash-one' };
  const uniqueTwo = { id: 'unique-two', idempotencyScope: 'shared-key', requestHash: 'hash-two' };
  const results = await Promise.all([
    store.insertRecordIfUniqueField('visit_notes', uniqueOne, 'idempotencyScope'),
    store.insertRecordIfUniqueField('visit_notes', uniqueTwo, 'idempotencyScope')
  ]);
  assert.equal(results.filter((result) => result.inserted).length, 1);
  assert.equal((await store.findRecordByField('visit_notes', 'idempotencyScope', 'shared-key'))?.id, results.find((result) => result.inserted)?.record.id);
});

test('due-work claims exclude competing workers and save only with the owning lease', async () => {
  const now = new Date();
  await store.insertRecordIfAbsent('webhook_deliveries', {
    id: 'claim-me', status: 'pending', nextAttemptAt: now.toISOString(), createdAt: now.toISOString(), attempts: 0
  });
  const claims = await Promise.all([
    store.claimDueRecord('webhook_deliveries', now, 'worker-a', 'lease-a', 60_000, 'claim-me'),
    store.claimDueRecord('webhook_deliveries', now, 'worker-b', 'lease-b', 60_000, 'claim-me')
  ]);
  const claimed = claims.find(Boolean);
  assert.ok(claimed);
  assert.equal(claims.filter(Boolean).length, 1);
  const winnerToken = claimed.leaseToken as string;
  const loserToken = winnerToken === 'lease-a' ? 'lease-b' : 'lease-a';
  assert.equal(await store.putRecordIfLease('webhook_deliveries', { ...claimed, status: 'delivered' }, loserToken), false);
  const completed = { ...claimed, status: 'delivered', leaseOwner: undefined, leaseToken: undefined, leaseUntil: undefined };
  assert.equal(await store.putRecordIfLease('webhook_deliveries', completed, winnerToken), true);
  assert.equal((await store.getRecord('webhook_deliveries', 'claim-me'))?.status, 'delivered');
});

test('expired event receipt retention deletes only records older than the cutoff', async () => {
  await store.insertRecordIfAbsent('event_receipts', { id: 'old', createdAt: '2020-01-01T00:00:00.000Z' });
  await store.insertRecordIfAbsent('event_receipts', { id: 'recent', createdAt: new Date().toISOString() });
  const deleted = await store.deleteRecordsBefore('event_receipts', 'createdAt', new Date('2021-01-01T00:00:00.000Z'));
  assert.equal(deleted, 1);
  assert.equal(await store.getRecord('event_receipts', 'old'), null);
  assert.ok(await store.getRecord('event_receipts', 'recent'));
});

test('record pagination sorts newest first and returns bounded page metadata', async () => {
  for (let index = 0; index < 7; index += 1) {
    await store.insertRecordIfAbsent('paged_records', { id: `page-${index}`, createdAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString() });
  }
  const page = await store.listRecordsPage('paged_records', 2, 3);
  assert.deepEqual(page.items.map((item) => item.id), ['page-3', 'page-2', 'page-1']);
  assert.equal(page.page, 2);
  assert.equal(page.limit, 3);
  assert.equal(page.total, 7);
  assert.equal(page.pages, 3);
  const bounded = await store.listRecordsPage('paged_records', 1, 500);
  assert.equal(bounded.limit, 100);
});

test('automation run pagination filters before slicing', async () => {
  for (let index = 0; index < 5; index += 1) {
    await store.insertRecordIfAbsent('automation_runs', { id: `run-a-${index}`, automationId: 'automation-a', createdAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString() });
    await store.insertRecordIfAbsent('automation_runs', { id: `run-b-${index}`, automationId: 'automation-b', createdAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString() });
  }
  const page = await store.listRecordsPageByField('automation_runs', 'automationId', 'automation-a', 2, 2);
  assert.deepEqual(page.items.map((item) => item.id), ['run-a-2', 'run-a-1']);
  assert.equal(page.total, 5);
  assert.equal(page.pages, 3);
});

test('terminal-record retention preserves pending delivery work', async () => {
  await store.insertRecordIfAbsent('delivery_retention', { id: 'old-delivered', status: 'delivered', createdAt: '2020-01-01T00:00:00.000Z' });
  await store.insertRecordIfAbsent('delivery_retention', { id: 'old-pending', status: 'pending', createdAt: '2020-01-01T00:00:00.000Z' });
  const deleted = await store.deleteTerminalRecordsBefore('delivery_retention', new Date('2021-01-01T00:00:00.000Z'), ['delivered', 'failed']);
  assert.equal(deleted, 1);
  assert.equal(await store.getRecord('delivery_retention', 'old-delivered'), null);
  assert.ok(await store.getRecord('delivery_retention', 'old-pending'));
});

test('concurrent access changes cannot remove the last active administrator', async () => {
  await store.insertRecordIfAbsent('users', { id: 'admin-one', email: 'one@example.test', role: 'admin', active: true, sessionVersion: 0 });
  await store.insertRecordIfAbsent('users', { id: 'admin-two', email: 'two@example.test', role: 'admin', active: true, sessionVersion: 0 });
  const results = await Promise.all([
    store.updateUserAccess('admin-one', { active: false }),
    store.updateUserAccess('admin-two', { role: 'staff' })
  ]);
  assert.equal(results.filter((result) => result.result === 'updated').length, 1);
  assert.equal(results.filter((result) => result.result === 'last_admin').length, 1);
  const remainingAdmins = (await store.listRecords<{ id: string; role: string; active?: boolean }>('users')).filter((user) => user.role === 'admin' && user.active !== false);
  assert.equal(remainingAdmins.length, 1);
});

test('a recovery code can only be consumed once, including concurrent attempts', async () => {
  await store.insertRecordIfAbsent('users', { id: 'mfa-user', email: 'mfa@example.test', role: 'admin', active: true, recoveryCodeHashes: ['hash-once'] });
  const results = await Promise.all([
    store.consumeUserRecoveryCode('mfa-user', 'hash-once', 0),
    store.consumeUserRecoveryCode('mfa-user', 'hash-once', 0)
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual((await store.getRecord('users', 'mfa-user'))?.recoveryCodeHashes, []);
});

test('rate-limit counters increment within a fixed window and reset at the next window', async () => {
  const key = `test:${Date.now()}:${Math.random()}`;
  assert.equal(await store.incrementRateLimitCounter(key, 1_000, 5_100), 1);
  assert.equal(await store.incrementRateLimitCounter(key, 1_000, 5_900), 2);
  assert.equal(await store.incrementRateLimitCounter(key, 1_000, 6_000), 1);
});
