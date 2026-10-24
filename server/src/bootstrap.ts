import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from './config/env.js';
import { initMongo } from './db/mongo.js';
import { findRecordByField, getRecord, initStore, insertRecordIfAbsent, insertRecordIfUniqueField } from './db/store.js';
import { collection, type ApiKey, type Automation, type PromptTemplate, type User } from './modules/models.js';

export async function bootstrap(): Promise<void> {
  await initStore();
  await initMongo();

  if (!await findRecordByField<User>(collection.users, 'email', env.ADMIN_EMAIL.toLowerCase())) {
    const user: User = {
      id: randomUUID(), email: env.ADMIN_EMAIL.toLowerCase(),
      passwordHash: await bcrypt.hash(env.ADMIN_PASSWORD, 12), role: 'admin', createdAt: new Date().toISOString()
    };
    await insertRecordIfUniqueField(collection.users, user, 'email');
  }

  if (env.NODE_ENV === 'production') return;

  const templateId = 'default-soap-template-v1';
  if (!await getRecord<PromptTemplate>(collection.templates, templateId)) {
    await insertRecordIfAbsent<PromptTemplate>(collection.templates, {
      id: templateId, name: 'SOAP note summary', version: 1, active: true,
      body: 'Summarize the following redacted clinical note into concise SOAP fields. Do not invent facts; use "Not documented" when a field is missing. Return only valid JSON with subjective, objective, assessment, plan, followUps (string array), and flags (string array).',
      createdAt: new Date().toISOString()
    });
  }

  const automationId = 'booking-created-summary-v1';
  if (!await getRecord<Automation>(collection.automations, automationId)) {
    await insertRecordIfAbsent<Automation>(collection.automations, {
      id: automationId, name: 'Booking confirmation summary', triggerEvent: 'booking.created', templateId, enabled: true, createdAt: new Date().toISOString()
    });
  }

  const publicKey = 'pk_test_mediassist';
  const apiKey: ApiKey = {
    id: 'local-widget-key', publicKey, clinicId: 'demo-clinic', enabled: true, createdAt: new Date().toISOString(),
    allowedOrigins: ['http://localhost:5174', 'http://127.0.0.1:5174', 'http://localhost:5173', 'http://127.0.0.1:5173']
  };
  await insertRecordIfAbsent(collection.apiKeys, apiKey);
}
