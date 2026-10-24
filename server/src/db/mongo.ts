import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import mongoose, { Schema } from 'mongoose';
import { env } from '../config/env.js';

export type LogType = 'request' | 'llm' | 'service_call' | 'webhook_attempt' | 'event';
export type LogEntry = {
  id?: string;
  type: LogType;
  correlationId: string;
  ts: string;
  status?: string | number;
  [key: string]: unknown;
};

const localLogPath = resolve(process.cwd(), env.DATA_DIR, 'logs.ndjson');
const schema = new Schema({
  type: { type: String, required: true, index: true },
  correlationId: { type: String, required: true, index: true },
  ts: { type: Date, required: true, default: Date.now },
  details: { type: Schema.Types.Mixed, default: {} }
}, { collection: 'mediassist_logs', versionKey: false });
schema.index({ ts: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });
schema.index({ type: 1, ts: -1 });
schema.index({ correlationId: 1, ts: -1 });
schema.index({ 'details.status': 1, ts: -1 });
const LogModel = mongoose.models.MediAssistLog ?? mongoose.model('MediAssistLog', schema);
let mongoReady = false;
let mongoConfigured = false;

export const logMode = env.MONGO_URL ? 'mongodb' : 'jsonl';

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function initMongo(): Promise<void> {
  if (!env.MONGO_URL) {
    await mkdir(dirname(localLogPath), { recursive: true });
    return;
  }
  mongoConfigured = true;
  try {
    await mongoose.connect(env.MONGO_URL, { serverSelectionTimeoutMS: 5000, tls: env.NODE_ENV === 'production' });
    await LogModel.createIndexes();
    mongoReady = true;
    mongoose.connection.on('connected', () => { mongoReady = true; });
    mongoose.connection.on('disconnected', () => { mongoReady = false; });
  } catch (error) {
    await mongoose.disconnect().catch(() => undefined);
    if (env.NODE_ENV === 'production') throw new Error('MongoDB is configured but unavailable; refusing to start without durable production logging.', { cause: error });
    await mkdir(dirname(localLogPath), { recursive: true });
    console.warn('MongoDB logs are unavailable; using local JSONL logs for this run.');
  }
}

export async function writeLog(entry: LogEntry): Promise<void> {
  const { type, correlationId, ts, ...details } = entry;
  if (mongoReady) {
    try {
      await LogModel.create({ type, correlationId, ts: new Date(ts), details });
      return;
    } catch (error) {
      mongoReady = false;
      if (env.NODE_ENV === 'production') throw error;
      console.warn('MongoDB log write failed; falling back to local JSONL logs.');
    }
  }
  if (mongoConfigured && env.NODE_ENV === 'production') throw new Error('MongoDB logs are unavailable.');
  try {
    await mkdir(dirname(localLogPath), { recursive: true });
    await appendFile(localLogPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(localLogPath, 0o600);
  } catch {
    console.error('MediAssist could not persist a log record.');
  }
}

export async function queryLogs(filters: {
  type?: string;
  status?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}): Promise<{ items: LogEntry[]; total: number }> {
  const start = (filters.page - 1) * filters.limit;
  if (mongoReady) {
    const query: Record<string, unknown> = {};
    if (filters.type) query.type = filters.type;
    if (filters.correlationId) query.correlationId = { $regex: escapeRegExp(filters.correlationId) };
    if (filters.status) {
      query['details.status'] = /^\d+$/.test(filters.status)
        ? { $in: [filters.status, Number(filters.status)] }
        : { $regex: `^${escapeRegExp(filters.status)}$`, $options: 'i' };
    }
    const ts: Record<string, Date> = {};
    if (filters.from) ts.$gte = new Date(filters.from);
    if (filters.to) ts.$lte = new Date(filters.to);
    if (Object.keys(ts).length) query.ts = ts;
    const [docs, total] = await Promise.all([
      LogModel.find(query).sort({ ts: -1 }).skip(start).limit(filters.limit).lean(),
      LogModel.countDocuments(query)
    ]);
    const items = docs.map((doc) => ({
      id: String(doc._id),
      type: doc.type as LogType,
      correlationId: doc.correlationId,
      ts: new Date(doc.ts).toISOString(),
      ...(doc.details as Record<string, unknown>)
    }));
    return { items, total };
  } else {
    let entries: LogEntry[];
    try {
      const contents = await readFile(localLogPath, 'utf8');
      entries = contents.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as LogEntry]; } catch { return []; }
      });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      entries = [];
    }

    const filtered = entries.filter((entry) => {
      if (Date.parse(entry.ts) < Date.now() - 14 * 24 * 60 * 60 * 1000) return false;
      if (filters.type && entry.type !== filters.type) return false;
      if (filters.correlationId && !entry.correlationId.toLowerCase().includes(filters.correlationId.toLowerCase())) return false;
      if (filters.status && String(entry.status ?? '').toLowerCase() !== filters.status.toLowerCase()) return false;
      if (filters.from && entry.ts < filters.from) return false;
      if (filters.to && entry.ts > filters.to) return false;
      return true;
    }).sort((a, b) => b.ts.localeCompare(a.ts));
    return { items: filtered.slice(start, start + filters.limit), total: filtered.length };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function mongoHealth(): Promise<{ mode: string; ok: boolean; detail?: string }> {
  if (!mongoReady) return { mode: mongoConfigured ? 'mongodb' : 'jsonl', ok: !mongoConfigured || env.NODE_ENV !== 'production' };
  try {
    await mongoose.connection.db?.admin().ping();
    return { mode: 'mongodb', ok: true };
  } catch (error) {
    return { mode: 'mongodb', ok: false, detail: error instanceof Error ? error.message : 'MongoDB unavailable' };
  }
}

export async function closeMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}
