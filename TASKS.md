# TASKS — S01 Accounts

Spec: `docs/specs/S01-accounts.md` (F01 customer accounts, F02 admin account, 2FA and audit log; ADR 0016). Two PRs; each leaves `main` green. PR 2 runs in its own session.

## PR 1 — Rename, contracts, db, api, worker (`feat/s01-accounts-backend`) · Opus 5.5 `high`
- [x] Rename staff → admin (spec "Rename"): contracts (`staff.ts` removed, `admin.ts`), db tables renamed in place (role and `staff_role` dropped), api module `admin`, `@AdminRoute()` without permissions, `ADMIN_AUTH_SECRET`, cookie `vd-admin`, CLI `admin:create` / `admin:reset-two-factor`, admin app names and client, folder `CLAUDE.md` files, `AGENTS.md`, `README.md`, `docs/deployment.md`, `.env.example`; Phase 0 tests pass under the new names; grep test (no `staff` in `apps/`, `packages/`); migration test (staff row survives as admin)
- [x] Contracts: `auth.ts` (password, admin password, name, phone E.164 with libphonenumber-js, OTP, sign-up, profile, email change, re-authenticate), common-password list, `admin.ts`, `audit.ts` (actions, actor kinds, channels, entry, cursor list query and page), `customers.ts` (test customers), error codes (`REGISTRATION_CLOSED`, `REAUTHENTICATION_REQUIRED`, `PASSWORD_CHANGE_REQUIRED`, `EMAIL_TAKEN`, `PASSWORD_TOO_COMMON`, `SESSION_IDLE_EXPIRED`, `INVALID_PASSWORD`, `INVALID_CODE`, `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`), email templates and job names; 100% unit-tested
- [x] Db (`/db-migration`): `customers.phone`, `customers.is_test`, `customer_rate_limits`, `admin_users.must_change_password` + single-row index, `admin_sessions.last_active_at` / `reauthenticated_at`, `audit_entries` (append-only trigger and grants), `email_outbox`; `recordAudit` shared write path; owners in `TABLE_OWNERS`; tests (append-only as the app role, second admin refused)
- [x] Api `auth` (customer): sign-up gated by `REGISTRATION_OPEN` with ALTCHA and enumeration-safe answers (C1, C2), email OTP plugin (C4, C5, C7), sign-in ALTCHA after 3 failures (C8), new-sign-in email (C10), change password / email (C11, C12), sessions (C14), disabled Better Auth routes, database rate-limit storage; `GET`/`PATCH /api/account`
- [x] Api `admin`: forced password change, `must_change_password` and TOTP gates in the guard, idle 30 min / absolute 12 h (D4), `POST /api/admin/me/reauthenticate` and a sensitive-route marker (D5), own sessions, backup codes, `admin.signed_in` audit; CLI `admin:reset-password` and audit entries for every CLI run
- [x] Api `audit`: `GET /api/admin/audit` (cursor, filters, actor names); api `customers`: test customers list, create, reset password (`no-store`)
- [x] Api `notifications`: outbox row + `email.send` job in the change's transaction (E1)
- [x] Api tests per module (spec "Tests": routes, guards, enumeration, limits surviving restart, concurrency, audit in the transaction, no secrets in `details`); `architecture.test.ts`
- [x] Worker: `email.send` (lock, expiry, render Arabic HTML + text through i18n, Nodemailer or file locally, clear code params, retries with backoff, Sentry) and `email.purge-codes` every 10 minutes; tests; SMTP env in `.env.example`
- [x] Bridge: build, OpenAPI export, admin client generated; admin app compiles against it
- [x] Wiring checklist, docs (`docs/architecture.md` modules, folder `CLAUDE.md`, `docs/deployment.md` env renames, commands table)
- [x] Checks (lint, typecheck, test, build, drift, e2e), reviewer (7 blocking findings fixed: code-check enumeration, decoy codes unmatchable, cursor precision, query parameters out of logs, pg-boss producer errors, CLI password kept, email-change code per customer), owner acceptance (2026-10-07), PR with auto-merge

## PR 2 — Store and admin screens, E2E (`feat/s01-accounts-screens`) · Opus 5.5 `medium`
- [x] Error codes of S01 in the store and admin catalogs, read by code (`errorMessage` maps API codes, not only Better Auth ones)
- [x] Api: `GET /api/auth/registration` (`{ open }`), so the store hides sign-up while it is closed (rule C16); OpenAPI and admin client regenerated
- [x] Store: `/sign-up`, `/verify-email`, `/sign-in` updates, `/forgot-password`, `/account`, `/account/email`, header account menu, closed-registration state; i18n, loading and error states
- [x] Admin: `/change-password`, re-authentication dialog, idle-expiry notice, `/account` (password, backup codes, sessions), `/audit` with filters and detail sheet, `/test-customers`, navigation; i18n
- [x] E2E: flows and RTL screenshots (store dark at phone width; admin light and dark)
- [x] Wiring checklist, "Patterns to copy" in `wiring.md`, `docs/ROADMAP.md` (S01 done)
- [x] Checks (lint, typecheck, test, build, e2e), reviewer (3 blocking findings fixed: idle notice lost on focus refetch, re-authentication wrapper on every admin mutation, registration read failure shown as closed), owner acceptance (2026-10-08), PR with auto-merge
