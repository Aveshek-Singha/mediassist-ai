export type User = {
  id: string;
  email: string;
  passwordHash: string;
  sessionVersion?: number;
  role: 'admin' | 'staff';
  active?: boolean;
  mfaEnabled?: boolean;
  mfaSecretEnc?: string;
  mfaPendingSecretEnc?: string;
  recoveryCodeHashes?: string[];
  createdAt: string;
};

export type SoapSummary = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  followUps: string[];
  flags: string[];
};

export type VisitNote = {
  id: string;
  redactedText: string;
  rawText?: string;
  summary?: SoapSummary;
  status: 'pending' | 'completed' | 'failed';
  error?: string;
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  idempotencyKey: string;
  idempotencyScope: string;
  requestHash: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseUntil?: string;
  correlationId: string;
  createdAt: string;
};

export type PromptTemplate = { id: string; name: string; version: number; body: string; active: boolean; createdAt: string };
export type Automation = { id: string; name: string; triggerEvent: string; templateId: string; enabled: boolean; createdAt: string };
export type AutomationRun = { id: string; automationId: string; triggerEvent: string; status: 'completed' | 'failed'; result?: unknown; error?: string; correlationId: string; createdAt: string };
export type EventReceipt = { id: string; eventType: string; requestHash?: string; status: 'pending' | 'completed' | 'failed'; correlationId: string; nextAttemptAt?: string; leaseOwner?: string; leaseToken?: string; leaseUntil?: string; error?: string; createdAt: string; completedAt?: string };
export type WebhookEndpoint = { id: string; url: string; secret: string; enabled: boolean; mode: 'ok' | '500' | 'timeout' | 'slow' | 'badsig'; createdAt: string };
export type WebhookDelivery = { id: string; endpointId: string; eventType: string; payload: unknown; status: 'pending' | 'delivered' | 'failed'; attempts: number; nextAttemptAt?: string; lastError?: string; correlationId: string; parentDeliveryId?: string; leaseOwner?: string; leaseToken?: string; leaseUntil?: string; createdAt: string; updatedAt: string };
export type ApiKey = { id: string; publicKey: string; allowedOrigins: string[]; clinicId: string; enabled: boolean; createdAt: string };

export const collection = {
  users: 'users',
  notes: 'visit_notes',
  templates: 'prompt_templates',
  automations: 'automations',
  runs: 'automation_runs',
  endpoints: 'webhook_endpoints',
  deliveries: 'webhook_deliveries',
  apiKeys: 'api_keys',
  eventReceipts: 'event_receipts'
} as const;
