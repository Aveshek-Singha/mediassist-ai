# MediBook service contract

The original external MediBook service was not available in this workspace. `mock-medibook` implements this contract so the complete booking flow can run locally. Set `MEDIBOOK_BASE_URL` and `MEDIBOOK_SERVICE_KEY` to use a real service with compatible routes.

All requests from the MediAssist server include `x-service-key` and `x-request-id`. The browser widget never receives the service key; it calls MediAssist's public API instead.

## Get available slots

`GET /slots?date=YYYY-MM-DD`

```json
{
  "slots": [
    { "id": "2026-10-26_0900", "date": "2026-10-26", "time": "09:00", "clinician": "Dr. Sen" }
  ]
}
```

## Create a booking

`POST /bookings`

```json
{
  "slotId": "2026-10-26_0900",
  "name": "Samira Ahmed",
  "email": "samira@example.test",
  "phone": "+880 1700 000000"
}
```

Returns HTTP `201` with `{ "booking": { "id", "slot", "name", "email", "phone", "status", "createdAt" } }`. Rebooking a slot returns `409`; an unknown booking returns `404`.

## Read bookings

- `GET /bookings` returns `{ "bookings": [...] }`.
- `GET /bookings/:id` returns `{ "booking": ... }`.
- `GET /health` is unauthenticated and reports `{ "status": "ok", "service": "mock-medibook" }`.

The mock stores bookings in process memory and resets when it restarts. That is deliberate for a disposable local integration demo; production booking state belongs to MediBook.
