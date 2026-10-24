import { env } from '../../config/env.js';
import { writeLog } from '../../db/mongo.js';
import { CircuitBreaker } from '../../lib/circuitBreaker.js';

export type Slot = { id: string; date: string; time: string; clinician: string };
export type BookingInput = { slotId: string; name: string; email: string; phone?: string };
export type Booking = { id: string; slot: Slot; name: string; email: string; phone?: string; status: string; createdAt: string };

class MediBookClient {
  private readonly breaker = new CircuitBreaker(5, 30_000);
  private readonly baseUrl = env.MEDIBOOK_BASE_URL.replace(/\/$/, '');

  private async request<T>(path: string, method: 'GET' | 'POST', body: unknown, correlationId: string, idempotencyKey?: string): Promise<T> {
    this.breaker.enter();
    let lastError: Error = new Error('MediBook request failed.');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = Date.now();
      let status: number | undefined;
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-service-key': env.MEDIBOOK_SERVICE_KEY,
            'x-request-id': correlationId,
            ...(method === 'POST' ? { 'idempotency-key': idempotencyKey ?? correlationId } : {})
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(5_000)
        });
        status = response.status;
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const error = new Error(`MediBook returned ${response.status}.`);
          Object.assign(error, { statusCode: response.status });
          if (response.status >= 500 && attempt < 3) {
            lastError = error;
          } else {
            if (response.status < 500) this.breaker.success();
            throw error;
          }
        } else {
          const result = await response.json() as T;
          this.breaker.success();
          await this.log(path, method, response.status, Date.now() - started, attempt, correlationId);
          return result;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('MediBook request failed.');
        if (status && status < 500) {
          await this.log(path, method, status, Date.now() - started, attempt, correlationId);
          throw lastError;
        }
        if (attempt === 3) this.breaker.failure();
      }
      await this.log(path, method, status ?? 0, Date.now() - started, attempt, correlationId);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * attempt + Math.random() * 150));
    }
    throw lastError;
  }

  private async log(path: string, method: string, status: number, durationMs: number, attempt: number, correlationId: string): Promise<void> {
    await writeLog({
      type: 'service_call', correlationId, ts: new Date().toISOString(), target: 'MediBook',
      method, url: `${this.baseUrl}${path}`, status, durationMs, attempt, breakerState: this.breaker.state
    });
  }

  slots(date: string, correlationId: string): Promise<{ slots: Slot[] }> {
    return this.request(`/slots?date=${encodeURIComponent(date)}`, 'GET', undefined, correlationId);
  }

  createBooking(input: BookingInput, correlationId: string, idempotencyKey?: string): Promise<{ booking: Booking }> {
    return this.request('/bookings', 'POST', input, correlationId, idempotencyKey);
  }

  bookings(correlationId: string): Promise<{ bookings: Booking[] }> {
    return this.request('/bookings', 'GET', undefined, correlationId);
  }

  getBooking(id: string, correlationId: string): Promise<{ booking: Booking }> {
    return this.request(`/bookings/${encodeURIComponent(id)}`, 'GET', undefined, correlationId);
  }
}

export const mediBook = new MediBookClient();
