import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { env } from '../config/env.js';

type Row = { id: string; [key: string]: unknown };
type LocalState = Record<string, Record<string, Row>>;

let pool: Pool | undefined;
let state: LocalState = {};
const dataDirectory = resolve(process.cwd(), env.DATA_DIR);
const filePath = resolve(dataDirectory, 'state.json');
let writeQueue = Promise.resolve();
let lastRateLimitCleanupAt = 0;
let localUserAdminQueue = Promise.resolve();
const localRateLimitCounters = new Map<string, { windowStartMs: number; hits: number }>();

export const storeMode = env.DATABASE_URL ? 'postgres' : 'file';

export async function initStore(): Promise<void> {
  if (env.DATABASE_URL) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: false,
      ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined
    });
    pool.on('error', (error) => console.error('PostgreSQL idle client error.', error.message));
    await runMigrations(pool);
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  try {
    state = JSON.parse(await readFile(filePath, 'utf8')) as LocalState;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    state = {};
    await persistLocal();
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function runMigrations(database: Pool): Promise<void> {
  const migrations: Array<{ version: number; sql: string }> = [
    {
      version: 1,
      sql: `CREATE TABLE IF NOT EXISTS app_records (
        collection text NOT NULL,
        id text NOT NULL,
        data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS app_records_collection_updated_idx ON app_records (collection, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS app_records_user_email_unique ON app_records ((lower(data->>'email'))) WHERE collection = 'users';
      CREATE UNIQUE INDEX IF NOT EXISTS visit_notes_idempotency_unique ON app_records ((data->>'idempotencyScope')) WHERE collection = 'visit_notes' AND data ? 'idempotencyScope';
      CREATE INDEX IF NOT EXISTS webhook_delivery_due_idx ON app_records ((data->>'nextAttemptAt'), updated_at) WHERE collection = 'webhook_deliveries' AND data->>'status' = 'pending';`
    },
    {
      version: 2,
      sql: `DROP INDEX IF EXISTS visit_notes_idempotency_unique;
      UPDATE app_records SET data = data || jsonb_build_object('idempotencyScope', 'legacy:' || (data->>'idempotencyKey'))
        WHERE collection = 'visit_notes' AND data ? 'idempotencyKey' AND NOT data ? 'idempotencyScope';
      CREATE UNIQUE INDEX visit_notes_idempotency_unique ON app_records ((data->>'idempotencyScope')) WHERE collection = 'visit_notes' AND data ? 'idempotencyScope';`
    },
    {
      version: 3,
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS app_records_api_key_unique
        ON app_records ((data->>'publicKey')) WHERE collection = 'api_keys';
      DROP INDEX IF EXISTS webhook_delivery_due_idx;
      CREATE INDEX webhook_delivery_due_idx
        ON app_records ((COALESCE((data->>'nextAttemptAt')::timestamptz, '-infinity'::timestamptz)), updated_at)
        WHERE collection = 'webhook_deliveries' AND data->>'status' = 'pending';`
    },
    {
      version: 4,
      sql: `CREATE TABLE IF NOT EXISTS rate_limit_counters (
        bucket text PRIMARY KEY,
        window_start_ms bigint NOT NULL,
        hits integer NOT NULL CHECK (hits > 0)
      );
      CREATE INDEX IF NOT EXISTS rate_limit_counters_window_idx ON rate_limit_counters (window_start_ms);`
    },
    {
      version: 5,
      sql: `CREATE INDEX IF NOT EXISTS app_records_collection_created_at_idx
        ON app_records (collection, ((data->>'createdAt')) DESC NULLS LAST, id DESC);`
    },
    {
      version: 6,
      sql: `CREATE INDEX IF NOT EXISTS app_records_automation_runs_page_idx
        ON app_records (collection, ((data->>'automationId')), ((data->>'createdAt')) DESC NULLS LAST, id DESC);`
    }
  ];

  await database.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const migration of migrations) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [2_145_002]);
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [migration.version]);
      if (existing.rowCount === 0) {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function persistLocal(): Promise<void> {
  const snapshot = JSON.stringify(state, null, 2);
  const operation = writeQueue.then(async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, filePath);
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
}

const searchableFields = new Set(['id', 'email', 'idempotencyScope', 'publicKey']);

export async function incrementRateLimitCounter(key: string, windowMs: number, nowMs = Date.now()): Promise<number> {
  const bucket = createHash('sha256').update(key).digest('hex');
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  if (pool) {
    if (nowMs - lastRateLimitCleanupAt >= 5 * 60_000) {
      lastRateLimitCleanupAt = nowMs;
      void pool.query('DELETE FROM rate_limit_counters WHERE window_start_ms < $1', [nowMs - 24 * 60 * 60_000]).catch(() => undefined);
    }
    const result = await pool.query<{ hits: number }>(
      `INSERT INTO rate_limit_counters (bucket, window_start_ms, hits) VALUES ($1, $2, 1)
       ON CONFLICT (bucket) DO UPDATE SET
         window_start_ms = EXCLUDED.window_start_ms,
         hits = CASE WHEN rate_limit_counters.window_start_ms = EXCLUDED.window_start_ms THEN rate_limit_counters.hits + 1 ELSE 1 END
       RETURNING hits`,
      [bucket, windowStartMs]
    );
    return result.rows[0]!.hits;
  }

  const current = localRateLimitCounters.get(bucket);
  const next = current?.windowStartMs === windowStartMs
    ? { windowStartMs, hits: current.hits + 1 }
    : { windowStartMs, hits: 1 };
  localRateLimitCounters.set(bucket, next);
  if (localRateLimitCounters.size > 10_000) {
    for (const [oldBucket, counter] of localRateLimitCounters) {
      if (counter.windowStartMs < nowMs - 24 * 60 * 60_000) localRateLimitCounters.delete(oldBucket);
    }
  }
  return next.hits;
}

export async function findRecordByField<T extends Row>(collection: string, field: string, value: string): Promise<T | null> {
  if (!searchableFields.has(field)) throw new Error('Unsupported record lookup field.');
  if (pool) {
    const result = await pool.query<{ data: T }>(
      `SELECT data FROM app_records WHERE collection = $1 AND data->>$2 = $3 LIMIT 1`,
      [collection, field, value]
    );
    return result.rows[0]?.data ?? null;
  }
  return (Object.values(state[collection] ?? {}).find((record) => String(record[field] ?? '') === value) as T | undefined) ?? null;
}

export async function insertRecordIfAbsent<T extends Row>(collection: string, record: T): Promise<{ record: T; inserted: boolean }> {
  if (pool) {
    const result = await pool.query<{ data: T }>(
      `INSERT INTO app_records (collection, id, data, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (collection, id) DO NOTHING RETURNING data`,
      [collection, record.id, JSON.stringify(record)]
    );
    if (result.rows[0]) return { record: result.rows[0].data, inserted: true };
    const existing = await getRecord<T>(collection, record.id);
    if (!existing) throw new Error('Record insert conflict could not be resolved.');
    return { record: existing, inserted: false };
  }
  state[collection] ??= {};
  const existing = state[collection][record.id] as T | undefined;
  if (existing) return { record: existing, inserted: false };
  state[collection][record.id] = record;
  await persistLocal();
  return { record, inserted: true };
}

export async function insertRecordIfUniqueField<T extends Row>(collection: string, record: T, field: 'idempotencyScope' | 'email'): Promise<{ record: T; inserted: boolean }> {
  if (!searchableFields.has(field)) throw new Error('Unsupported unique field.');
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${collection}:${field}:${String(record[field] ?? '').toLowerCase()}`]);
      const existing = await client.query<{ data: T }>(
        `SELECT data FROM app_records WHERE collection = $1 AND lower(data->>$2) = lower($3) LIMIT 1`,
        [collection, field, String(record[field] ?? '')]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { record: existing.rows[0].data, inserted: false };
      }
      const inserted = await client.query<{ data: T }>(
        'INSERT INTO app_records (collection, id, data, updated_at) VALUES ($1, $2, $3::jsonb, now()) RETURNING data',
        [collection, record.id, JSON.stringify(record)]
      );
      await client.query('COMMIT');
      return { record: inserted.rows[0]!.data, inserted: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  state[collection] ??= {};
  const current = Object.values(state[collection]).find((item) => String(item[field] ?? '').toLowerCase() === String(record[field] ?? '').toLowerCase()) as T | undefined;
  if (current) return { record: current, inserted: false };
  state[collection][record.id] = record;
  await persistLocal();
  return { record, inserted: true };
}

export async function claimDueRecord<T extends Row>(collection: string, now: Date, leaseOwner: string, leaseToken: string, leaseMs: number, recordId?: string): Promise<T | null> {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string; data: T }>(
        `SELECT id, data FROM app_records
         WHERE collection = $1 AND data->>'status' = 'pending'
           AND ($3::text IS NULL OR id = $3)
           AND COALESCE((data->>'nextAttemptAt')::timestamptz, '-infinity'::timestamptz) <= $2::timestamptz
           AND COALESCE((data->>'leaseUntil')::timestamptz, '-infinity'::timestamptz) <= $2::timestamptz
         ORDER BY COALESCE((data->>'nextAttemptAt')::timestamptz, '-infinity'::timestamptz), updated_at
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [collection, nowIso, recordId ?? null]
      );
      if (!result.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const claimed = { ...result.rows[0].data, leaseOwner, leaseToken, leaseUntil } as T;
      await client.query('UPDATE app_records SET data = $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2', [collection, result.rows[0].id, JSON.stringify(claimed)]);
      await client.query('COMMIT');
      return claimed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const candidate = Object.values(state[collection] ?? {})
    .filter((record) => (!recordId || record.id === recordId) && record.status === 'pending'
      && (!record.nextAttemptAt || Date.parse(String(record.nextAttemptAt)) <= now.getTime())
      && (!record.leaseUntil || Date.parse(String(record.leaseUntil)) <= now.getTime()))
    .sort((left, right) => String(left.nextAttemptAt ?? left.createdAt ?? '').localeCompare(String(right.nextAttemptAt ?? right.createdAt ?? '')))[0];
  if (!candidate) return null;
  const claimed = { ...candidate, leaseOwner, leaseToken, leaseUntil } as unknown as T;
  state[collection]![claimed.id] = claimed;
  await persistLocal();
  return structuredClone(claimed);
}

export async function putRecordIfLease<T extends Row>(collection: string, record: T, leaseToken: string): Promise<boolean> {
  if (pool) {
    const result = await pool.query(
      `UPDATE app_records SET data = $4::jsonb, updated_at = now()
       WHERE collection = $1 AND id = $2 AND data->>'leaseToken' = $3`,
      [collection, record.id, leaseToken, JSON.stringify(record)]
    );
    return (result.rowCount ?? 0) === 1;
  }
  const existing = state[collection]?.[record.id];
  if (!existing || existing.leaseToken !== leaseToken) return false;
  state[collection]![record.id] = record;
  await persistLocal();
  return true;
}

export async function getRecord<T extends Row>(collection: string, id: string): Promise<T | null> {
  if (pool) {
    const result = await pool.query<{ data: T }>('SELECT data FROM app_records WHERE collection = $1 AND id = $2', [collection, id]);
    return result.rows[0]?.data ?? null;
  }
  return (state[collection]?.[id] as T | undefined) ?? null;
}

export async function listRecords<T extends Row>(collection: string): Promise<T[]> {
  if (pool) {
    const result = await pool.query<{ data: T }>('SELECT data FROM app_records WHERE collection = $1 ORDER BY updated_at DESC', [collection]);
    return result.rows.map((row) => row.data);
  }
  return Object.values(state[collection] ?? {}) as T[];
}

export async function listRecordsPage<T extends Row>(collection: string, page: number, limit: number): Promise<{ items: T[]; page: number; limit: number; total: number; pages: number }> {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  if (pool) {
    const offset = (safePage - 1) * safeLimit;
    const [records, count] = await Promise.all([
      pool.query<{ data: T }>(
        `SELECT data FROM app_records WHERE collection = $1 ORDER BY (data->>'createdAt') DESC NULLS LAST, id DESC LIMIT $2 OFFSET $3`,
        [collection, safeLimit, offset]
      ),
      pool.query<{ total: string }>('SELECT count(*)::text AS total FROM app_records WHERE collection = $1', [collection])
    ]);
    const total = Number(count.rows[0]?.total ?? 0);
    return { items: records.rows.map((row) => row.data), page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) };
  }
  const all = Object.values(state[collection] ?? {}) as T[];
  all.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || right.id.localeCompare(left.id));
  const total = all.length;
  const start = (safePage - 1) * safeLimit;
  return { items: all.slice(start, start + safeLimit), page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) };
}

export async function listRecordsPageByField<T extends Row>(collection: string, field: 'automationId', value: string, page: number, limit: number): Promise<{ items: T[]; page: number; limit: number; total: number; pages: number }> {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  if (pool) {
    const offset = (safePage - 1) * safeLimit;
    const [records, count] = await Promise.all([
      pool.query<{ data: T }>(
        `SELECT data FROM app_records WHERE collection = $1 AND data->>$2 = $3 ORDER BY (data->>'createdAt') DESC NULLS LAST, id DESC LIMIT $4 OFFSET $5`,
        [collection, field, value, safeLimit, offset]
      ),
      pool.query<{ total: string }>('SELECT count(*)::text AS total FROM app_records WHERE collection = $1 AND data->>$2 = $3', [collection, field, value])
    ]);
    const total = Number(count.rows[0]?.total ?? 0);
    return { items: records.rows.map((row) => row.data), page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) };
  }
  const matching = Object.values(state[collection] ?? {}).filter((record) => String(record[field] ?? '') === value) as T[];
  matching.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || right.id.localeCompare(left.id));
  const total = matching.length;
  const start = (safePage - 1) * safeLimit;
  return { items: matching.slice(start, start + safeLimit), page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) };
}

export async function putRecord<T extends Row>(collection: string, record: T): Promise<T> {
  if (pool) {
    await pool.query(
      `INSERT INTO app_records (collection, id, data, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [collection, record.id, JSON.stringify(record)]
    );
  } else {
    state[collection] ??= {};
    state[collection][record.id] = record;
    await persistLocal();
  }
  return record;
}

export async function updateUserRecord<T extends Row>(id: string, update: (current: T) => T | null): Promise<T | null> {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{ data: T }>('SELECT data FROM app_records WHERE collection = $1 AND id = $2 FOR UPDATE', ['users', id]);
      const current = selected.rows[0]?.data;
      if (!current) { await client.query('COMMIT'); return null; }
      const next = update(current);
      if (!next) { await client.query('COMMIT'); return null; }
      await client.query('UPDATE app_records SET data = $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2', ['users', id, JSON.stringify(next)]);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  let release!: () => void;
  const previous = localUserAdminQueue;
  localUserAdminQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const current = state.users?.[id] as T | undefined;
    if (!current) return null;
    const next = update(current);
    if (!next) return null;
    state.users![id] = next;
    await persistLocal();
    return next;
  } finally {
    release();
  }
}

export async function updateUserAccess(id: string, changes: { role?: 'admin' | 'staff'; active?: boolean }): Promise<{ record: Row | null; result: 'updated' | 'not_found' | 'last_admin' }> {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [2_145_003]);
      const selected = await client.query<{ data: Row }>('SELECT data FROM app_records WHERE collection = $1 AND id = $2 FOR UPDATE', ['users', id]);
      const current = selected.rows[0]?.data;
      if (!current) { await client.query('COMMIT'); return { record: null, result: 'not_found' }; }
      const becomesActiveAdmin = (changes.role ?? current.role) === 'admin' && (changes.active ?? current.active !== false);
      const isActiveAdmin = current.role === 'admin' && current.active !== false;
      if (isActiveAdmin && !becomesActiveAdmin) {
        const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM app_records WHERE collection = 'users' AND data->>'role' = 'admin' AND COALESCE(data->>'active', 'true') <> 'false'");
        if (Number(count.rows[0]?.count ?? 0) <= 1) { await client.query('COMMIT'); return { record: current, result: 'last_admin' }; }
      }
      const updated: Row = { ...current, ...changes, sessionVersion: (typeof current.sessionVersion === 'number' ? current.sessionVersion : 0) + 1 };
      await client.query('UPDATE app_records SET data = $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2', ['users', id, JSON.stringify(updated)]);
      await client.query('COMMIT');
      return { record: updated, result: 'updated' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  let release!: () => void;
  const previous = localUserAdminQueue;
  localUserAdminQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const current = state.users?.[id];
    if (!current) return { record: null, result: 'not_found' };
    const becomesActiveAdmin = (changes.role ?? current.role) === 'admin' && (changes.active ?? current.active !== false);
    const isActiveAdmin = current.role === 'admin' && current.active !== false;
    if (isActiveAdmin && !becomesActiveAdmin) {
      const admins = Object.values(state.users ?? {}).filter((user) => user.role === 'admin' && user.active !== false);
      if (admins.length <= 1) return { record: current, result: 'last_admin' };
    }
    const updated = { ...current, ...changes, sessionVersion: (typeof current.sessionVersion === 'number' ? current.sessionVersion : 0) + 1 };
    state.users![id] = updated;
    await persistLocal();
    return { record: updated, result: 'updated' };
  } finally {
    release();
  }
}

export async function consumeUserRecoveryCode(id: string, codeHash: string, expectedSessionVersion: number): Promise<Row | null> {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{ data: Row }>('SELECT data FROM app_records WHERE collection = $1 AND id = $2 FOR UPDATE', ['users', id]);
      const current = selected.rows[0]?.data;
      const hashes = Array.isArray(current?.recoveryCodeHashes) ? current.recoveryCodeHashes.filter((value): value is string => typeof value === 'string') : [];
      if (!current || current.active === false || current.role !== 'admin'
        || (typeof current.sessionVersion === 'number' ? current.sessionVersion : 0) !== expectedSessionVersion
        || !hashes.includes(codeHash)) { await client.query('ROLLBACK'); return null; }
      const updated: Row = { ...current, recoveryCodeHashes: hashes.filter((value) => value !== codeHash) };
      await client.query('UPDATE app_records SET data = $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2', ['users', id, JSON.stringify(updated)]);
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  let release!: () => void;
  const previous = localUserAdminQueue;
  localUserAdminQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const current = state.users?.[id];
    const hashes = Array.isArray(current?.recoveryCodeHashes) ? current.recoveryCodeHashes.filter((value): value is string => typeof value === 'string') : [];
    if (!current || current.active === false || current.role !== 'admin'
      || (typeof current.sessionVersion === 'number' ? current.sessionVersion : 0) !== expectedSessionVersion
      || !hashes.includes(codeHash)) return null;
    const updated = { ...current, recoveryCodeHashes: hashes.filter((value) => value !== codeHash) };
    state.users![id] = updated;
    await persistLocal();
    return updated;
  } finally {
    release();
  }
}

export async function deleteRecord(collection: string, id: string): Promise<void> {
  if (pool) {
    await pool.query('DELETE FROM app_records WHERE collection = $1 AND id = $2', [collection, id]);
  } else {
    if (state[collection]) delete state[collection][id];
    await persistLocal();
  }
}

export async function deleteRecordsBefore(collection: string, field: 'createdAt', cutoff: Date): Promise<number> {
  if (pool) {
    const result = await pool.query(
      `DELETE FROM app_records WHERE collection = $1 AND (data->>$2)::timestamptz < $3::timestamptz`,
      [collection, field, cutoff.toISOString()]
    );
    return result.rowCount ?? 0;
  }
  const records = state[collection] ?? {};
  const expiredIds = Object.values(records).filter((record) => Date.parse(String(record[field] ?? '')) < cutoff.getTime()).map((record) => record.id);
  for (const id of expiredIds) delete records[id];
  if (expiredIds.length) await persistLocal();
  return expiredIds.length;
}

export async function deleteTerminalRecordsBefore(collection: string, cutoff: Date, statuses: readonly string[]): Promise<number> {
  if (!statuses.length) return 0;
  if (pool) {
    const result = await pool.query(
      `DELETE FROM app_records WHERE collection = $1 AND data->>'status' = ANY($2::text[])
       AND (data->>'createdAt')::timestamptz < $3::timestamptz`,
      [collection, statuses, cutoff.toISOString()]
    );
    return result.rowCount ?? 0;
  }
  const records = state[collection] ?? {};
  const statusSet = new Set(statuses);
  const expiredIds = Object.values(records).filter((record) => statusSet.has(String(record.status ?? '')) && Date.parse(String(record.createdAt ?? '')) < cutoff.getTime()).map((record) => record.id);
  for (const id of expiredIds) delete records[id];
  if (expiredIds.length) await persistLocal();
  return expiredIds.length;
}

export async function storageHealth(): Promise<{ mode: string; ok: boolean; detail?: string }> {
  if (pool) {
    try {
      await pool.query('SELECT 1');
      return { mode: 'postgres', ok: true };
    } catch (error) {
      return { mode: 'postgres', ok: false, detail: error instanceof Error ? error.message : 'database unavailable' };
    }
  }
  return { mode: 'file', ok: true };
}

export async function closeStore(): Promise<void> {
  await pool?.end();
}
