import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import express from 'express';
import { z } from 'zod';

dotenv.config({ path: resolve(process.cwd(), '../.env') });

const app = express();
app.use(express.json({ limit: '64kb' }));

type Slot = { id: string; date: string; time: string; clinician: string };
type Booking = { id: string; slot: Slot; name: string; email: string; phone?: string; status: 'confirmed'; createdAt: string };
const bookings = new Map<string, Booking>();
const idempotentBookings = new Map<string, Booking>();
const slotsFor = (date: string): Slot[] => {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (weekday === 0 || weekday === 6 || date < new Date().toISOString().slice(0, 10)) return [];
  return ['09:00', '10:30', '13:00', '15:30']
    .map((time) => ({ id: `${date}_${time.replace(':', '')}`, date, time, clinician: time.startsWith('1') ? 'Dr. Rahman' : 'Dr. Sen' }))
    .filter((slot) => ![...bookings.values()].some((booking) => booking.slot.id === slot.id));
};

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.header('x-service-key') !== (process.env.MEDIBOOK_SERVICE_KEY ?? 'local-medibook-service-key')) return res.status(401).json({ error: 'Invalid service key.' });
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mock-medibook' }));
app.get('/slots', (req, res) => {
  const parsed = z.string().date().safeParse(req.query.date);
  if (!parsed.success) return res.status(400).json({ error: 'date must use YYYY-MM-DD.' });
  res.json({ slots: slotsFor(parsed.data) });
});
app.get('/bookings', (_req, res) => res.json({ bookings: [...bookings.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));
app.get('/bookings/:id', (req, res) => {
  const booking = bookings.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ booking });
});
app.post('/bookings', (req, res) => {
  const parsed = z.object({ slotId: z.string(), name: z.string().min(2).max(120), email: z.string().email(), phone: z.string().max(40).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Provide a valid slot, name, and email.' });
  const { slotId, name, email, phone } = parsed.data;
  const idempotencyKey = req.header('idempotency-key') ?? req.header('x-request-id');
  const prior = idempotencyKey ? idempotentBookings.get(idempotencyKey) : undefined;
  if (prior) return res.status(201).json({ booking: prior });
  const [date, rawTime] = slotId.split('_');
  const slot = slotsFor(date ?? '').find((item) => item.id === slotId);
  if (!slot || !rawTime) return res.status(409).json({ error: 'That slot is no longer available. Refresh the list and choose another time.' });
  const booking: Booking = { id: randomUUID(), slot, name: name.trim(), email: email.toLowerCase(), phone, status: 'confirmed', createdAt: new Date().toISOString() };
  bookings.set(booking.id, booking);
  if (idempotencyKey) idempotentBookings.set(idempotencyKey, booking);
  res.status(201).json({ booking });
});

const port = Number(process.env.MEDIBOOK_PORT ?? 4100);
app.listen(port, '0.0.0.0', () => console.log(`Mock MediBook listening on http://localhost:${port}`));
