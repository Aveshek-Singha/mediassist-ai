export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:4000' : window.location.origin)).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly payload: unknown) { super(message); }
}

export async function api<T>(path: string, token?: string | null, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    credentials: options.credentials ?? 'include',
    cache: options.cache ?? 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || `Request failed (${response.status}).`, response.status, payload);
  return payload as T;
}

export type User = { id: string; email: string; role: 'admin' | 'staff'; active?: boolean; createdAt?: string };
export type Booking = { id: string; slot: { date: string; time: string; clinician: string }; name: string; email: string; phone?: string; status: string; createdAt: string };
export type VisitNote = { id: string; redactedText: string; summary?: { subjective: string; objective: string; assessment: string; plan: string; followUps: string[]; flags: string[] }; status: string; error?: string; provider?: string; model?: string; tokensIn?: number; tokensOut?: number; latencyMs?: number; correlationId: string; createdAt: string };
export type Automation = { id: string; name: string; triggerEvent: string; templateId: string; enabled: boolean; createdAt: string };
export type Endpoint = { id: string; url: string; enabled: boolean; mode: 'ok' | '500' | 'timeout' | 'slow' | 'badsig'; createdAt: string };
export type Delivery = { id: string; endpointId: string; eventType: string; status: string; attempts: number; nextAttemptAt?: string; lastError?: string; correlationId: string; parentDeliveryId?: string; createdAt: string; updatedAt: string };
export type LogEntry = { id?: string; type: string; correlationId: string; ts: string; status?: string | number; [key: string]: unknown };
