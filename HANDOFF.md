# MediAssist project handoff

Updated: 2026-10-24

## Project status

MediAssist is a single-clinic operations app with a React dashboard, Express API, embeddable booking widget, demo site, and local MediBook mock. Docker is not required for development. The repository-level implementation and checks are in good shape, but this workspace is **not ready for production patient data** until the external deployment and clinic-specific items below are completed.

## Work completed

- Browser sessions use HttpOnly cookies with origin checks; API clients can use bearer tokens. Logout, password changes, and account disablement invalidate prior sessions.
- Admin MFA supports TOTP and one-use recovery codes. Role permissions cover staff and admin workflows.
- Added bounded API pagination, payload limits, retention handling, and related production configuration checks.
- Webhooks use signed payloads, retry/replay handling, target validation, DNS pinning, and no redirect following.
- Visit-note processing redacts common identifiers before LLM calls and clearly labels the result as a draft requiring clinician review.
- Fixed mobile horizontal overflow in bookings, overview, widget setup, and automations.
- Expanded integration coverage for logout/session replay and related API flows.

## Verification completed

- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm test:unit` — 20 passed.
- `pnpm build` — all workspace packages built.
- `pnpm audit --audit-level=moderate` — no known vulnerabilities.
- `pnpm test:integration` — all integration smoke checks passed, including auth, role permissions, widget booking, notes, automation, webhook retry/replay, correlated logs, and logout.
- Browser testing covered admin and staff access, MFA enrollment/TOTP/recovery, bookings and notes, widget booking on mobile, widget key lifecycle, prompt/automation creation and run controls, signed sandbox delivery/replay, log filters/details, password change and restoration, and sign-out. Tested mobile viewport was 390px wide with no horizontal overflow.

Useful references: [README.md](README.md), [mediassist-final-plan.md](mediassist-final-plan.md), [integration-smoke.mjs](scripts/integration-smoke.mjs), [auth routes](server/src/modules/auth/routes.ts), and [dashboard styles](client/src/ui/styles.css).

## Production launch blockers

Complete and verify these with the deploying clinic/operations team before going live:

1. Provision PostgreSQL and MongoDB with verified TLS, managed credentials, durable backups, and a tested restore procedure.
2. Configure production secrets and endpoints from the README, including MediBook credentials and webhook secret, approved LLM provider credentials, stable encryption keys, and a unique admin account. Verify the real MediBook contract in staging.
3. Configure HTTPS hosting, trusted proxy depth, dashboard/API origins, secure cookies, `VITE_API_BASE_URL`, and the dashboard host’s `frame-ancestors 'none'` or `X-Frame-Options: DENY` response header.
4. Obtain clinic-approved privacy notice, note and event retention periods, vendor/data-processing agreements, and legal/compliance review. Do not treat best-effort redaction as a compliance guarantee.
5. Establish monitoring and alerting, incident response, capacity/load validation, deployment rollback, and a production staging acceptance run.
6. Confirm admin MFA enrollment and test the full production login and recovery process.

The backend requires hosted PostgreSQL and MongoDB in production and fails closed if required services are unavailable. It is scoped to one clinic per installation; multi-tenant isolation is not implemented. See the README’s “Backend design and production configuration” section for required environment variables and operational details.

## Workspace notes for the next person

- This workspace snapshot has no `.git` directory, so branch, commit, and clean-diff status could not be verified. Confirm the intended Git checkout before committing or publishing changes.
- Local `.data` contains synthetic browser/integration test records, including a disabled QA widget key and webhook endpoint and a paused QA automation. Preserve existing data unless cleanup is explicitly planned.
- The admin password used for the browser test was restored after the password-change flow.
- Standard development services on ports 5173, 5174, 4000, and 4100 were left running. Temporary MFA/browser test services were stopped.
- The workspace contains a `.env` file. Do not copy secret values into handoff notes, logs, or source control.
