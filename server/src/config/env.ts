import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

loadDotenv({ path: resolve(process.cwd(), '../.env') });

const production = process.env.NODE_ENV === 'production';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z.string().optional().default(''),
  MONGO_URL: z.string().optional().default(''),
  DATA_DIR: z.string().min(1).default('.data'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  JSON_BODY_LIMIT: z.string().min(1).default('1mb'),
  JWT_SECRET: z.string().min(16).default(production ? '' : 'local-only-secret-change-before-deploy'),
  WEBHOOK_ENCRYPTION_KEY: z.string().min(32).default(production ? '' : 'local-webhook-encryption-key-change-before-production'),
  ADMIN_EMAIL: z.string().email().default(production ? '' : 'admin@mediassist.local'),
  ADMIN_PASSWORD: z.string().min(12).default(production ? '' : 'change-this-demo-password'),
  MEDIBOOK_BASE_URL: z.string().url().default(production ? '' : 'http://localhost:4100'),
  MEDIBOOK_SERVICE_KEY: z.string().min(8).default(production ? '' : 'local-medibook-service-key'),
  MEDIBOOK_WEBHOOK_SECRET: z.string().min(16).default(production ? '' : 'local-medibook-webhook-secret'),
  LLM_PROVIDER: z.string().default('openai'),
  LLM_API_KEY: z.string().optional().default(''),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_MODEL: z.string().min(1).default('gpt-4o-mini'),
  MOCK_LLM: z.enum(['true', 'false']).default('true'),
  STORE_RAW_NOTES: z.enum(['true', 'false']).default('false'),
  REQUIRE_ADMIN_MFA: z.enum(['true', 'false']).default(production ? 'true' : 'false'),
  CLINICAL_NOTE_RETENTION_DAYS: z.coerce.number().int().min(-1).max(3650).default(production ? -1 : 0),
  EVENT_RECEIPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(14),
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  AUTOMATION_RUN_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  WEBHOOK_BACKOFF_SCALE: z.coerce.number().positive().default(1),
  WEBHOOK_POLL_MS: z.coerce.number().int().min(250).default(production ? 5_000 : 1_000),
  CORS_ADMIN_ORIGIN: z.string().min(1).default(production ? '' : 'http://localhost:5173,http://127.0.0.1:5173'),
  PUBLIC_BASE_URL: z.string().url().default(production ? '' : 'http://localhost:4000'),
  LLM_PRICE_IN_PER_MTOK: z.coerce.number().nonnegative().optional(),
  LLM_PRICE_OUT_PER_MTOK: z.coerce.number().nonnegative().optional()
});

export const env = envSchema.parse(process.env);
export function validateProductionConfig(config = env): void {
  if (config.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (!/^postgres(ql)?:\/\//i.test(config.DATABASE_URL)) problems.push('DATABASE_URL must point to PostgreSQL.');
  if (!/^mongodb(?:\+srv)?:\/\//i.test(config.MONGO_URL)) problems.push('MONGO_URL must point to MongoDB.');
  if (config.JWT_SECRET.length < 32 || /change|local-only|example/i.test(config.JWT_SECRET)) problems.push('JWT_SECRET must be a unique secret of at least 32 characters.');
  if (config.ADMIN_PASSWORD === 'change-this-demo-password' || config.ADMIN_PASSWORD.length < 12) problems.push('Set a unique ADMIN_PASSWORD of at least 12 characters.');
  if (config.WEBHOOK_ENCRYPTION_KEY.startsWith('local-') || config.WEBHOOK_ENCRYPTION_KEY.length < 32) problems.push('Set a unique WEBHOOK_ENCRYPTION_KEY of at least 32 characters.');
  if (config.MEDIBOOK_SERVICE_KEY === 'local-medibook-service-key' || config.MEDIBOOK_SERVICE_KEY.length < 16) problems.push('Set a unique MEDIBOOK_SERVICE_KEY of at least 16 characters.');
  if (config.MEDIBOOK_WEBHOOK_SECRET === 'local-medibook-webhook-secret' || config.MEDIBOOK_WEBHOOK_SECRET.length < 32) problems.push('Set a unique MEDIBOOK_WEBHOOK_SECRET of at least 32 characters.');
  for (const [name, value] of [['MEDIBOOK_BASE_URL', config.MEDIBOOK_BASE_URL], ['PUBLIC_BASE_URL', config.PUBLIC_BASE_URL]] as const) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') problems.push(`${name} must use HTTPS in production.`);
      if (url.username || url.password || url.search || url.hash) problems.push(`${name} must not contain credentials, query parameters, or a fragment.`);
    }
    catch { problems.push(`${name} must be configured with a valid HTTPS URL.`); }
  }
  const adminOrigins = config.CORS_ADMIN_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (adminOrigins.length === 0 || adminOrigins.some((origin) => {
    try { return new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:'; }
    catch { return true; }
  })) problems.push('CORS_ADMIN_ORIGIN must contain exact HTTPS origins, separated by commas.');
  if (config.MOCK_LLM !== 'false' || !config.LLM_API_KEY) problems.push('Configure LLM_API_KEY and set MOCK_LLM=false for production.');
  try {
    const url = new URL(config.LLM_BASE_URL);
    if (url.protocol !== 'https:') problems.push('LLM_BASE_URL must use HTTPS in production.');
    if (url.username || url.password || url.search || url.hash) problems.push('LLM_BASE_URL must not contain credentials, query parameters, or a fragment.');
  }
  catch { problems.push('LLM_BASE_URL must be configured with a valid HTTPS URL.'); }
  if (config.STORE_RAW_NOTES !== 'false') problems.push('STORE_RAW_NOTES must remain false in production.');
  if (config.REQUIRE_ADMIN_MFA !== 'true') problems.push('REQUIRE_ADMIN_MFA must be true in production.');
  if (config.CLINICAL_NOTE_RETENTION_DAYS < 0) problems.push('Set CLINICAL_NOTE_RETENTION_DAYS to match the clinic-approved clinical-record retention policy; use 0 only for an approved indefinite-retention policy.');
  const bodyLimit = /^(\d+)(b|kb|mb)$/i.exec(config.JSON_BODY_LIMIT.trim());
  const bodyLimitBytes = bodyLimit ? Number(bodyLimit[1]) * ({ b: 1, kb: 1024, mb: 1024 * 1024 }[bodyLimit[2]!.toLowerCase() as 'b' | 'kb' | 'mb']) : Number.POSITIVE_INFINITY;
  if (bodyLimitBytes < 1024 || bodyLimitBytes > 1024 * 1024) problems.push('JSON_BODY_LIMIT must be between 1kb and 1mb in production.');
  if (problems.length) throw new Error(`Production configuration is incomplete:\n- ${problems.join('\n- ')}`);
}
validateProductionConfig();

export const isMockLlm = env.MOCK_LLM === 'true';
export const adminOrigins = env.CORS_ADMIN_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
