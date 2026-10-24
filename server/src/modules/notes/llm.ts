import { env, isMockLlm } from '../../config/env.js';
import { writeLog } from '../../db/mongo.js';
import { logger } from '../../lib/logger.js';
import { soapSummarySchema } from './schemas.js';
import type { SoapSummary } from '../models.js';

type LlmResult = { content: string; provider: string; model: string; tokensIn: number; tokensOut: number };

function mockResult(prompt: string): LlmResult {
  const clinicalText = prompt.split('CLINICAL NOTE:').at(-1)?.trim() ?? '';
  const summary: SoapSummary = {
    subjective: clinicalText ? `Reported history: ${clinicalText.slice(0, 240)}` : 'Not documented.',
    objective: 'No objective findings were extracted. Clinician review required.',
    assessment: 'A clinician should review the source note and confirm the assessment.',
    plan: 'Review this draft, correct any missing facts, and document the care plan.',
    followUps: ['Clinician review required'],
    flags: ['Mock LLM output; verify before clinical use']
  };
  return { content: JSON.stringify(summary), provider: 'mock', model: 'deterministic-mock', tokensIn: Math.ceil(prompt.length / 4), tokensOut: Math.ceil(JSON.stringify(summary).length / 4) };
}

async function providerCall(prompt: string, correlationId: string): Promise<LlmResult> {
  if (isMockLlm) {
    const result = mockResult(prompt);
    await writeLog({ type: 'llm', correlationId, ts: new Date().toISOString(), provider: result.provider, model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut, latencyMs: 1, status: 'completed', retries: 0 });
    return result;
  }

  let lastError = 'LLM provider request failed.';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${env.LLM_API_KEY}`, 'content-type': 'application/json', 'x-request-id': correlationId },
        body: JSON.stringify({ model: env.LLM_MODEL, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) {
        lastError = `LLM provider returned ${response.status}.`;
        await response.body?.cancel().catch(() => undefined);
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await writeLog({ type: 'llm', correlationId, ts: new Date().toISOString(), provider: env.LLM_PROVIDER, model: env.LLM_MODEL, latencyMs: Date.now() - started, status: 'retry', retries: attempt + 1, errorCode: String(response.status) });
          await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt) + Math.random() * 250));
          continue;
        }
        throw new Error(lastError);
      }
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM provider returned an empty result.');
      const result = {
        content, provider: env.LLM_PROVIDER, model: env.LLM_MODEL,
        tokensIn: payload.usage?.prompt_tokens ?? 0, tokensOut: payload.usage?.completion_tokens ?? 0
      };
      const cost = env.LLM_PRICE_IN_PER_MTOK !== undefined && env.LLM_PRICE_OUT_PER_MTOK !== undefined
        ? (result.tokensIn * env.LLM_PRICE_IN_PER_MTOK + result.tokensOut * env.LLM_PRICE_OUT_PER_MTOK) / 1_000_000
        : undefined;
      await writeLog({ type: 'llm', correlationId, ts: new Date().toISOString(), provider: result.provider, model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut, latencyMs: Date.now() - started, status: 'completed', retries: attempt, cost });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
      const retryable = !(error instanceof Error && error.name === 'AbortError');
      if (attempt < 2 && retryable && /fetch|network|timeout|timed out|429|5\d\d/i.test(lastError)) {
        await writeLog({ type: 'llm', correlationId, ts: new Date().toISOString(), provider: env.LLM_PROVIDER, model: env.LLM_MODEL, latencyMs: Date.now() - started, status: 'retry', retries: attempt + 1, errorCode: 'provider_error' });
        await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt) + Math.random() * 250));
        continue;
      }
      await writeLog({ type: 'llm', correlationId, ts: new Date().toISOString(), provider: env.LLM_PROVIDER, model: env.LLM_MODEL, latencyMs: Date.now() - started, status: 'failed', retries: attempt, errorCode: 'provider_error' });
      break;
    }
  }
  logger.warn({ correlationId }, 'LLM provider request failed');
  throw new Error(lastError);
}

function parseSummary(content: string): SoapSummary {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('The model returned invalid JSON.'); }
  const parsed = soapSummarySchema.safeParse(value);
  if (!parsed.success) throw new Error('The model response did not match the SOAP schema.');
  return parsed.data;
}

export async function summarizeNote(text: string, template: string, correlationId: string): Promise<{ summary: SoapSummary; provider: string; model: string; tokensIn: number; tokensOut: number }> {
  const prompt = `${template}\n\nCLINICAL NOTE:\n${text}`;
  let result = await providerCall(prompt, correlationId);
  try {
    return { summary: parseSummary(result.content), provider: result.provider, model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
  } catch {
    result = await providerCall(`Repair the following response into valid JSON matching this schema: subjective, objective, assessment, plan (strings), followUps and flags (string arrays). Return JSON only.\n\n${result.content}`, correlationId);
    return { summary: parseSummary(result.content), provider: result.provider, model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
  }
}
