# S01 — Accounts (F01 Customer accounts · F02 Admin account, 2FA and audit log)

Status: Approved · Date: 2026-10-07 · Scope: `docs/product/v1-scope.md` §F01, §F02 (and §F26 for the closed registration) · ADRs: 0007, 0008, 0011, 0014, 0016

## Summary
Customers need an account they trust: sign-up with email, password, name and phone; an email OTP that proves the address; recovery without the admin; a security page showing every signed-in device. The store is run by one admin account with full access (ADR 0016): no staff, no roles, no permission map. That account keeps mandatory TOTP, short sessions, re-authentication before sensitive actions, and an append-only audit log of every money and admin action. Phase 0 shipped the sign-in skeletons (both Better Auth instances, staff TOTP, first-owner CLI); S01 completes them, removes staff and roles from the code (renaming `staff` to `admin`), adds the email outbox that every customer email goes through, and lets the admin create test customers while registration is closed.

## In scope / out of scope
- In:
  - Customer sign-up (name, email, password, phone), email verification by 6-digit OTP, sign-in, sign-out, forgot password by email OTP, change password, change email (OTP to the new address), edit name and phone, active sessions with "sign out" per session and "sign out everywhere".
  - Customer security emails: verification code, password-reset code, email-change code, "your email was changed" (to the old address), "your password was changed", "new sign-in", "someone tried to sign up with your email".
  - The email outbox (`notifications` module) and the worker's `email.send` job; local development writes emails to files.
  - Sign-up gated by `REGISTRATION_OPEN` until S05 replaces it with the store switch (rule C16).
  - Test customers created by the admin from the panel.
  - The single admin account (ADR 0016): created and recovered by CLI only; forced change of a CLI-issued password; change password; regenerate backup codes; own sessions.
  - Admin session rules: 30-minute idle timeout, 12-hour absolute lifetime; re-authentication (password + TOTP) valid for 5 minutes.
  - Removing staff from the code: roles, the permission map and `@StaffRoute(permission…)` go; `staff` becomes `admin` in code, tables, routes' internals, CLI scripts and the folder docs (section "Rename").
  - The `audit` module (`audit_entries`, `recordAudit`) and the audit log screen; audit entries for the CLI tools.
- Out (later or never):
  - Notification preferences on the account page, in-site notification center: S05 (F27). Security emails stay non-optional.
  - The registration switch in the panel and its history: S05 (F26). Freezing, limits, customer search and notes: S12 (F19).
  - Telegram linking for the admin: S05 (F07).
  - Wallet ledger account per customer: S02 (F03).
  - Staff accounts, roles, permissions, a second admin: not in V1 (ADR 0016).
  - Customer self-deletion: never in V1 (the account holds a wallet and its history); a customer asks support, the admin archives (F19).
  - Phone OTP, social sign-in, passkeys, customer 2FA, "trust this device" for the admin, admin password reset by email or from the panel: not in V1.
  - Audit log export: not in V1.

## Access
| Action | Route kind | Who |
|---|---|---|
| Sign up, verify email, request a code, sign in, forgot password | Public (ALTCHA, rate limits) | Anyone; sign-up only while registration is open |
| Read and edit own profile, change password or email, list and revoke own sessions | Customer | Signed-in customer with a verified email |
| Sign in, TOTP step, enrol TOTP, change a CLI-issued password | Admin auth | The admin |
| Everything under `/api/admin/` (account, re-authentication, audit log, test customers, and every later admin screen) | Admin | The admin, signed in with TOTP enrolled and no pending password change |
| Create the admin, reset the admin's password or TOTP | CLI on the server | Whoever has server access (the owner) |

## Rename (staff → admin)
Done in the S01 implementation, before the new features, so every later spec builds on the new names:
- Contracts: `packages/contracts/src/staff.ts` is removed (`STAFF_ROLES`, `PERMISSIONS`, `ROLE_PERMISSIONS`, `hasPermission`); `admin.ts` holds the admin schemas.
- Database: `staff_users` → `admin_users`, `staff_sessions` → `admin_sessions`, `staff_accounts` → `admin_accounts`, `staff_verifications` → `admin_verifications`, `staff_two_factors` → `admin_two_factors`, with their indexes; `admin_users.role` and the `staff_role` enum are dropped. The migration renames (no drop and create), so the production admin row created in Phase 0 survives with its password and TOTP.
- API: the `staff` module becomes `admin` (`admin-auth.config.ts`, `admin-auth.service.ts`, `admin-accounts.ts`); `@StaffRoute(...permissions)` becomes `@AdminRoute()` (no arguments); the access guard drops the permission check; `STAFF_AUTH_SECRET` → `ADMIN_AUTH_SECRET`, cookie prefix `vd-staff` → `vd-admin` (production `__Host-vd-admin`).
- CLI: `staff:create-owner` → `admin:create`, `staff:reset-two-factor` → `admin:reset-two-factor`, new `admin:reset-password`.
- Admin app: `features/account` and `lib/auth.ts` names; navigation without permission checks.
- Docs that describe the code: `AGENTS.md` and `README.md` (command names), `docs/deployment.md` (secret and command names), `docs/decisions/0011` is amended by 0016 (not edited), every folder `CLAUDE.md` that names staff (`apps/api`, `apps/admin`, `apps/worker`, `packages/db`, `packages/contracts`, `deploy`), `.env.example`, and the server's `.env` key rename at the Phase 1 deploy (noted in `docs/deployment.md`).
- The rename moves no data and changes no behaviour beyond dropping roles; its own tests (existing staff tests renamed) must pass before the new work starts.

## Data

### `customers` (exists; owner: `auth`)
Added columns:
- `phone` text, required: E.164 (`+9639xxxxxxxx` for a Syrian mobile). Not unique (rule C6). Index `customers_phone_idx`.
- `is_test` boolean, required, default `false`: set only when the admin creates a test customer. Reports and dashboards (S12, S13) exclude test customers.

The migration adds `phone` as `NOT NULL` without a default: no customer rows exist in any environment yet (sign-up is disabled since Phase 0). The migration fails loudly rather than inventing phones if a row exists.

### `customer_sessions` (exists)
No new columns. Better Auth refreshes `expires_at` (30 days) at most once a day of use; `updated_at` is shown as "last active".

### Customer rate counters (new, owner: `auth`)
Better Auth's database rate-limit storage for the customer instance (`customer_rate_limits`: `key` unique, `count`, `last_request` bigint), so OTP and sign-up counters survive restarts (ADR 0008). The admin instance keeps memory storage.

### `admin_users` (renamed from `staff_users`; owner: `admin`)
- `role` dropped.
- Added `must_change_password` boolean, required, default `false`: set by `admin:create` and `admin:reset-password`; cleared by the admin's own password change.
- At most one row: a unique index on a constant expression (`admin_users_single_idx` on `((true))`) makes a second admin impossible at the database level. `archived_at` stays for the Better Auth hook but is never set in V1.

### `admin_sessions` (renamed from `staff_sessions`)
Added columns:
- `last_active_at` timestamptz, required, default `now()`: updated by the access guard at most once a minute.
- `reauthenticated_at` timestamptz, nullable: set by a successful re-authentication on this session.

### `admin_accounts`, `admin_verifications`, `admin_two_factors`
Renamed from `staff_*`, unchanged otherwise.

### `audit_entries` (new; owner: `audit`; append-only)
- `id` uuid v7, primary key.
- `occurred_at` timestamptz, required, default `now()`.
- `actor_kind` enum `audit_actor_kind`: `admin`, `customer`, `system`, `cli`.
- `actor_id` uuid, nullable (null for `system` and `cli`). No foreign key: the column holds the admin's or a customer's id depending on `actor_kind`.
- `channel` enum `audit_channel`: `admin`, `store`, `telegram`, `worker`, `cli`.
- `action` text, required: `<entity>.<verb>` from `AUDIT_ACTIONS` in `packages/contracts` (each spec adds its actions).
- `entity_type` text, required (`admin_user`, `customer`, later `deposit`, `order`, …); `entity_id` uuid, required.
- `reason` text, nullable: required by the actions that ask for one (later specs; none in S01).
- `details` jsonb, required, default `{}`: before and after of changed fields. Never a password, hash, OTP, TOTP secret, backup code, token or session id.
- `ip_address` text, nullable; `user_agent` text, nullable.
- Indexes: `(occurred_at desc, id desc)`, `(actor_kind, actor_id, occurred_at desc)`, `(entity_type, entity_id, occurred_at desc)`, `(action, occurred_at desc)`.
- No `updated_at` or `archived_at`. A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`, and the app role has `INSERT` and `SELECT` only (as the ledger tables, ADR 0011, 0014).

### `email_outbox` (new; owner: `notifications`)
- `id` uuid v7; `to_address` text, required; `template` enum `email_template` (the S01 values below; later specs add theirs); `params` jsonb, nullable; `priority` enum `email_priority`: `high` (codes), `normal`.
- `status` enum `email_status`: `pending`, `sent`, `failed`; `attempts` integer default 0; `last_error` text nullable (SMTP error class and message, never the body); `sent_at` timestamptz nullable.
- `customer_id` uuid nullable, foreign key to `customers`; `expires_at` timestamptz nullable (code emails: the code's expiry).
- `...timestamps()`. Not archived: an outbox row is a delivery record, not a business record.
- Indexes `(status, created_at)`, `(customer_id, created_at desc)`.
- `params` of a code email holds the code only until the email is sent or `expires_at` passes; then the worker sets `params` to null (rule E4).

S01 templates: `customer_verify_email`, `customer_reset_password`, `customer_change_email`, `customer_email_changed`, `customer_password_changed`, `customer_new_sign_in`, `customer_sign_up_attempt`.

### Contracts (`packages/contracts`)
- `auth.ts`: `passwordSchema` (rule C3), `adminPasswordSchema` (rule D6), `fullNameSchema` (2–60 characters after trim, no control characters), `phoneSchema` (libphonenumber-js, default region `SY`, any valid number, output E.164), `otpCodeSchema` (6 digits), `customerSignUpSchema`, `customerProfileSchema`, `updateCustomerProfileSchema`, `requestEmailChangeSchema`, `reauthenticateSchema` (`password` + `totpCode`).
- `admin.ts` (replaces `staff.ts`): `adminSessionSchema` (own sessions list).
- `audit.ts` (new): `AUDIT_ACTIONS`, `auditActorKindSchema`, `auditChannelSchema`, `auditEntrySchema`, `auditListQuerySchema` (cursor list, ADR 0011).
- `customers.ts` (new): `testCustomerSchema`, `createTestCustomerSchema`.
- `errors.ts`: add `REGISTRATION_CLOSED`, `REAUTHENTICATION_REQUIRED`, `PASSWORD_CHANGE_REQUIRED`, `EMAIL_TAKEN`, `PASSWORD_TOO_COMMON`, `SESSION_IDLE_EXPIRED`. `FORBIDDEN` stays for customer-to-admin and admin-to-customer refusals.
- A short list of the most common passwords (about 10,000 entries, lowercased) as a data file in `packages/contracts`, checked by both password schemas. No external lookup.

## States and rules

### Customer account states
`unverified` (signed up, email not verified) → `verified` (OTP confirmed, or password reset by OTP) → `archived` (by the admin, F19; no sign-in). An unverified account has no session: sign-in answers `EMAIL_NOT_VERIFIED` and sends a new code (subject to the code limits).

### Customer rules
- C1. Sign-up requires name, email, password and phone, and a solved ALTCHA. It creates an unverified customer and queues `customer_verify_email`. No session is created before verification.
- C2. Sign-up with an email that already has an account answers exactly as a new sign-up ("we sent a code to your email"), creates nothing, and queues `customer_sign_up_attempt` to that address (once per address per hour). No response, timing or status reveals whether an email is registered.
- C3. Customer passwords: 8 to 128 characters, no composition rules, refused when in the common-password list (`PASSWORD_TOO_COMMON`) or equal to the email.
- C4. OTP codes: 6 digits, valid 10 minutes, at most 5 wrong attempts, after which the code is void and a new one must be requested. A new code voids the previous code of the same purpose.
- C5. Code sends per email: one per 60 seconds, 5 per hour, 10 per day; per IP: 20 per hour. Every send request needs a solved ALTCHA. Limits are counted in PostgreSQL.
- C6. Phone numbers are not unique. Accounts sharing a phone number are a fraud signal shown to the admin in F19 (S12).
- C7. Verifying the email signs the customer in (one session). A password reset by OTP also verifies the email (the code proves the address) and signs out every session, without signing in: the customer signs in with the new password.
- C8. Sign-in: per IP 10 per minute (Phase 0); after 3 failed sign-ins for one email within 15 minutes, the sign-in needs a solved ALTCHA (as the admin sign-in, ADR 0007). Error messages never tell whether the email exists.
- C9. Sessions last 30 days and are extended by use (refreshed at most once a day). Cookie rules from ADR 0007.
- C10. Every successful sign-in queues `customer_new_sign_in` (time, browser and system from the user agent, IP address), except the session created by email verification (C7).
- C11. Change password needs the current password; it signs out every other session and queues `customer_password_changed`.
- C12. Change email needs the current password and a code sent to the new address. When the new address belongs to another account, the request answers the same, sends no code and queues `customer_sign_up_attempt` to that address. On confirmation the email changes, every other session is signed out, and `customer_email_changed` goes to the old address.
- C13. Name and phone are editable by the customer at any time; each change is audited with before and after.
- C14. "Sign out" on one session revokes it; "sign out everywhere" revokes every session, the current one included, and returns to the sign-in page.
- C15. An archived customer cannot sign in (Phase 0 hook) and every existing session stops working at once.
- C16. While `REGISTRATION_OPEN` is not `true`, sign-up answers `REGISTRATION_CLOSED` and the store hides the sign-up link. It defaults to closed in production; local `.env` and E2E set it open. S05 replaces this variable with the registration switch (F26).
- C17. Customer routes refuse admin sessions and admin routes refuse customer sessions (Phase 0, ADR 0007).

### Test customers
- T1. The admin creates a test customer with name, email and phone. The account is verified at once, `is_test = true`, and a generated password (24 random base64url characters) is shown once in the panel. No email is sent.
- T2. The admin may reset a test customer's password from the panel (new generated password shown once, every session signed out). Real customers are never reset by the admin in S01.
- T3. The email must be unused by any customer (`EMAIL_TAKEN` is fine here: admin-only route).
- T4. A test customer otherwise behaves as any customer, including changing their own password.

### Admin account states
`must_change_password` (after `admin:create` or `admin:reset-password`) → `needs_totp` (no TOTP enrolled) → `active`. Both of the first two can hold at once: the order is password change, then TOTP enrolment.

### Admin rules
- D1. Exactly one admin account exists (database index, ADR 0016). `admin:create --email --name` refuses when one exists and prints a generated password once; the admin must change it at first sign-in, then enrol TOTP. Until both are done, every admin route other than those steps answers `PASSWORD_CHANGE_REQUIRED` or `TWO_FACTOR_REQUIRED`.
- D2. `admin:reset-password` prints a new generated password once, sets `must_change_password`, signs the admin out everywhere; TOTP stays enrolled.
- D3. `admin:reset-two-factor` removes the TOTP secret and backup codes and signs the admin out everywhere; the admin enrols again at the next sign-in. There is no panel route for either reset.
- D4. Sessions end after 30 minutes without a request (`SESSION_IDLE_EXPIRED`, the session is deleted) or 12 hours after sign-in, whichever comes first. Panel polling made on its own (no user action) does not count as activity.
- D5. Re-authentication: `password` + `totpCode` on the current session sets `reauthenticated_at`. Routes marked sensitive answer `REAUTHENTICATION_REQUIRED` when it is missing or older than 5 minutes; the panel then shows the re-authentication dialog and retries the action. Backup codes are not accepted for re-authentication. Rate limits as the sign-in (per IP 10 per minute). Sensitive actions are marked by the specs that add them (refunds above a limit, wallet adjustments, rate changes, supplier keys, switches); S01 adds the mechanism and marks none of its own routes.
- D6. Admin passwords: 12 to 128 characters, not in the common-password list, not equal to the email. Generated passwords: 24 random base64url characters.
- D7. The admin changes their own password with the current password; every other session is signed out. Regenerating backup codes needs the password and shows the new codes once.
- D8. The admin receives no email in V1; there is no password reset by email.

### Audit rules
- A1. `recordAudit(tx, entry)` writes in the caller's transaction; a business change and its audit entry commit or roll back together.
- A2. Every admin action that changes data writes an entry, as does every customer account change (C1, C7, C11–C14) and every CLI tool run.
- A3. Entries are never changed or deleted (trigger and grants). Retention: forever in V1.
- A4. The audit log lists newest first with cursor pagination, filtered by actor kind (admin, customer with an optional customer id, system, CLI), action, entity (type and id) and date range. Times show in the viewer's time zone.

S01 actions: `admin.created`, `admin.password_reset`, `admin.two_factor_reset` (all CLI), `admin.signed_in`, `admin.password_changed`, `admin.two_factor_enabled`, `admin.backup_codes_regenerated`, `admin.sessions_revoked`, `customer.signed_up`, `customer.email_verified`, `customer.profile_updated`, `customer.email_changed`, `customer.password_changed`, `customer.password_reset`, `customer.sessions_revoked`, `customer.test_created`, `customer.test_password_reset`. Customer sign-ins are not audited (the session list and the sign-in email cover them); failed sign-ins go to the logs and fail2ban, not the audit table.

### Email rules
- E1. Every email is a row in `email_outbox` plus an `email.send` job, written in the same transaction as the change that causes it (the job is sent on the same connection, ADR 0011). The API never talks to SMTP.
- E2. Code emails are `high` priority and are not retried after their `expires_at`.
- E3. Emails are Arabic, RTL, HTML with a plain-text part, rendered by the worker through i18n; `EMAIL_FROM` is the sender. They contain the code (code emails only), never a password, a link with a token, a session history or amounts.
- E4. After sending, or once `expires_at` passes, the worker sets `params` of code emails to null.
- E5. Locally (`NODE_ENV` development and test) the worker writes each email to a file under a git-ignored folder instead of sending.

## Money flows
None. S01 moves no money and creates no ledger accounts; the customer wallet account arrives with S02 (F03).

## API
Better Auth endpoints keep their paths and bodies; the rows below name the ones S01 enables and what S01 adds around them. Paths under `/api/auth` are the customer instance, under `/api/admin/auth` the admin instance.

### Customer
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `POST /api/auth/sign-up/email` | Public, ALTCHA | `customerSignUpSchema` | `{ status: 'code_sent' }` | `REGISTRATION_CLOSED`, `VALIDATION_FAILED`, `PASSWORD_TOO_COMMON`, `ALTCHA_*`, `RATE_LIMITED` |
| `POST /api/auth/email-otp/send-verification-otp` | Public, ALTCHA | `{ email, type: 'email-verification' }` | `{ success }` (always) | `ALTCHA_*`, `RATE_LIMITED` |
| `POST /api/auth/email-otp/verify-email` | Public | `{ email, otp }` | session cookie + user | Better Auth OTP codes (`INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`), `RATE_LIMITED` |
| `POST /api/auth/sign-in/email` | Public, ALTCHA after failures (C8) | `signInSchema` | session cookie + user | `INVALID_EMAIL_OR_PASSWORD`, `EMAIL_NOT_VERIFIED`, `ALTCHA_*`, `RATE_LIMITED` |
| `POST /api/auth/sign-out` | Customer session | — | `{ success }` | — |
| `POST /api/auth/email-otp/request-password-reset` | Public, ALTCHA | `{ email }` | `{ success }` (always) | `ALTCHA_*`, `RATE_LIMITED` |
| `POST /api/auth/email-otp/reset-password` | Public | `{ email, otp, password }` | `{ success }` | OTP codes, `PASSWORD_TOO_COMMON`, `RATE_LIMITED` |
| `POST /api/auth/change-password` | Customer | `{ currentPassword, newPassword }` (other sessions always revoked) | `{ success }` | `INVALID_PASSWORD`, `PASSWORD_TOO_COMMON`, `RATE_LIMITED` |
| `POST /api/auth/email-otp/request-email-change` | Customer, ALTCHA | `requestEmailChangeSchema` (`newEmail`, `password`) | `{ success }` (always, C12) | `INVALID_PASSWORD`, `ALTCHA_*`, `RATE_LIMITED` |
| `POST /api/auth/email-otp/change-email` | Customer | `{ newEmail, otp }` | `{ success }` | OTP codes, `EMAIL_TAKEN` (race only), `RATE_LIMITED` |
| `GET /api/auth/list-sessions` | Customer | — | sessions (device, IP, created, last active, current) | `UNAUTHORIZED` |
| `POST /api/auth/revoke-session` · `POST /api/auth/revoke-sessions` | Customer | `{ token }` · — | `{ success }` | `UNAUTHORIZED` |
| `GET /api/account` | Customer | — | `customerProfileSchema` (name, email, phone, created) | `UNAUTHORIZED`, `EMAIL_NOT_VERIFIED` |
| `PATCH /api/account` | Customer | `updateCustomerProfileSchema` (name, phone) | `customerProfileSchema` | `VALIDATION_FAILED` |

Better Auth's own `/update-user`, `/change-email` (link flow), `/send-verification-email`, `/verify-email`, `/request-password-reset`, `/reset-password` stay disabled; profile changes go through `PATCH /api/account` so they are audited and validated by the contract.

### Admin
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `POST /api/admin/auth/sign-in/email`, `/two-factor/*` | Admin auth (Phase 0) | — | — | Phase 0 codes |
| `POST /api/admin/auth/change-password` | Admin session (allowed while `must_change_password`) | `{ currentPassword, newPassword }` | `{ success }` | `INVALID_PASSWORD`, `PASSWORD_TOO_COMMON`, `RATE_LIMITED` |
| `POST /api/admin/auth/two-factor/generate-backup-codes` | Admin | `{ password }` | codes once | `INVALID_PASSWORD` |
| `POST /api/admin/me/reauthenticate` | Admin | `reauthenticateSchema` | `{ reauthenticatedUntil }` | `INVALID_PASSWORD`, `INVALID_CODE`, `RATE_LIMITED` |
| `GET /api/admin/me/sessions` · `DELETE /api/admin/me/sessions/:id` | Admin | — | own sessions | `NOT_FOUND` |
| `GET /api/admin/audit` | Admin | `auditListQuerySchema` | page of `auditEntrySchema` with actor names | `VALIDATION_FAILED` |
| `GET /api/admin/test-customers` | Admin | cursor | page of `testCustomerSchema` | — |
| `POST /api/admin/test-customers` | Admin | `createTestCustomerSchema` | customer + `password` (once) | `EMAIL_TAKEN`, `VALIDATION_FAILED` |
| `POST /api/admin/test-customers/:id/reset-password` | Admin | — | `{ password }` (once) | `NOT_FOUND` (real customers too) |

Every admin route also answers `UNAUTHORIZED`, `FORBIDDEN` (customer session), `SESSION_IDLE_EXPIRED`, `TWO_FACTOR_REQUIRED`, `PASSWORD_CHANGE_REQUIRED` and `CROSS_ORIGIN_REFUSED` as the guard decides. Responses that carry a one-time password set `Cache-Control: no-store`.

## Jobs and integrations
- `email.send` (worker, `notifications`): payload `{ outboxId }`. Locks the outbox row (`FOR UPDATE SKIP LOCKED`), returns if not `pending`; marks `failed` without sending a code email past `expires_at`; renders the template; sends by SMTP (Nodemailer) or writes the file locally; marks `sent`, clears code `params`. Retries 5 times with exponential backoff from 10 seconds; after the last, `failed` and a Sentry event. Safe twice: a sent row is never sent again; a crash between SMTP and the update can send one email twice, accepted for email.
- `email.purge-codes` (worker, every 10 minutes): nulls `params` of code emails whose `expires_at` passed (covers rows the send job never reached).
- SMTP settings in the worker's environment (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`); `.env.example` gets fake values.
- No supplier, blockchain or Telegram calls.

## Screens

### Store (Arabic, RTL, phone width first; all account pages are dynamic and never cached)
- `/sign-up`: name, email, password (show/hide), phone with country picker defaulting to Syria (`09xxxxxxxx` accepted and shown as `+963 9xx xxx xxx`), ALTCHA, submit. Link to sign-in. When registration is closed the route shows a calm "registration opens soon" message and no form. Field errors inline; server errors through `errors.<code>`.
- `/verify-email`: six-digit code input (one field, numeric keyboard, paste of the whole code works), the address it was sent to, "resend" with a 60-second countdown (ALTCHA on resend), "change email" returns to sign-up. On success: signed in, redirect to the page they came from or home.
- `/sign-in` (exists): adds the ALTCHA after failures, "forgot password" link, and sends unverified accounts to `/verify-email`.
- `/forgot-password`: step 1 email (+ALTCHA) → step 2 code + new password; success sends to sign-in with a notice.
- `/account`: profile (name and phone edited inline; email with "change", opening `/account/email`) and security (change password; sessions list with browser and system, IP, last active, "this device" badge, "sign out" per row and "sign out everywhere" with a confirm dialog). Notification preferences arrive with S05.
- `/account/email`: new email + current password (+ALTCHA) → code sent to the new address → enter code → done.
- Loading: skeletons sized to the content. Errors: a form alert with the next step ("try again in a minute", "request a new code").
- Header: signed-out shows "sign in" (and "create account" when registration is open); signed-in shows the name's initial with a menu (account, sign out).

### Admin (Arabic, RTL)
- `/change-password` (outside the shell, like `/setup-two-factor`): forced when `must_change_password`; current (CLI-issued) password and new password twice.
- Re-authentication dialog (shared component): password + 6-digit TOTP code; opened automatically on `REAUTHENTICATION_REQUIRED`, then the action is retried.
- Idle expiry: on `SESSION_IDLE_EXPIRED` the panel goes to `/login` with a "session ended after 30 minutes of inactivity" notice and returns to the same page after sign-in.
- `/account`: change password, regenerate backup codes (shown once, copy or download as text), own sessions with "sign out" per session.
- `/audit`: table of time, actor (admin, "customer" with the customer's name, "system", "CLI"), action (translated label), entity (type + short id, copyable), channel; filters: actor kind (and customer id), action, entity type + id, date range; newest first with "load more". A row opens a side sheet with the details as labelled before/after values, IP and user agent. Empty state: "no entries match these filters".
- `/test-customers`: list of test customers (name, email, phone, created); "add test customer" dialog → password shown once with copy button and a "will not be shown again" warning; "reset password" per row with a confirm dialog. Empty state: "no test customers yet" with the add button.
- The shell's navigation has Audit log, Test customers and Account; no permission checks.

## Audit and notifications
- Audit: every action listed in "Audit rules" above, in the same transaction as the change. `admin.signed_in` is written when the TOTP step completes (the session becomes usable).
- Customer emails (security, cannot be turned off): `customer_verify_email`, `customer_reset_password`, `customer_change_email` (to the new address), `customer_email_changed` (to the old address), `customer_password_changed`, `customer_new_sign_in`, `customer_sign_up_attempt`.
- No admin notifications and no Telegram messages in S01.

## Abuse and fraud
| Abuse | Control |
|---|---|
| Bot sign-ups, mass accounts | Registration closed until the pilot (C16); ALTCHA on sign-up; per-IP sign-up limit (5 per hour) and nginx auth zone; new-account limits come with deposits (Q5) |
| Email bombing through code sends | ALTCHA on every send; per-email and per-IP limits in PostgreSQL (C5); C2 attempt notice limited to once per address per hour |
| Account enumeration | Identical responses for sign-up, code requests, password reset and email change whether or not the email exists (C2, C12); generic sign-in errors |
| OTP brute force | 6 digits, 10 minutes, 5 attempts per code, new code voids the old, send limits (C4, C5) |
| Credential stuffing | Per-IP sign-in limit, ALTCHA after 3 failures per email, fail2ban on repeated 401/429, common-password list, new sign-in email (C8, C10) |
| Stolen customer session | `HttpOnly` `__Host-` cookie, session list with remote sign-out, password or email change signs out other sessions |
| Account takeover by email change | Current password + code to the new address + notice to the old address + other sessions signed out (C12) |
| Phone squatting | Phones not unique (C6) |
| Admin password theft | Mandatory TOTP, no trusted devices, 12-character minimum, no reset by email or from the panel (D3, D6, D8) |
| Unattended admin screen | 30-minute idle timeout; re-authentication within 5 minutes for sensitive actions (D4, D5) |
| A second admin slipped in (bug, SQL, script) | Single-row index on `admin_users`; `admin:create` refuses when one exists (D1) |
| Covering tracks after a compromise | Audit append-only by trigger and grants; CLI runs audited; no delete route |
| CLI-issued passwords leaking | Printed once, never logged, must be changed at first sign-in (D1, D2) |
| Test accounts misused | Only the admin creates them, flagged `is_test`, audited, excluded from reports; their one-time passwords are `no-store` |
| Secrets in logs or emails | Audit `details` and outbox `params` never hold passwords or tokens; code params cleared after send (E4); Sentry and logs scrub OTPs and phones (ADR 0008) |
| Cross-surface sessions | Customer and admin instances, cookies and route guards separate (C17) |

## Edge cases
1. `admin:create` run twice at once: the advisory lock (Phase 0) and the single-row index let one succeed; the other fails with "an admin exists".
2. The admin loses the TOTP device and the backup codes: `admin:reset-two-factor` on the server (D3); without server access there is no recovery, by design (ADR 0016).
3. `admin:reset-password` while the admin is signed in: every session is deleted at once; the open panel goes to sign-in.
4. A customer requests a second code before using the first: the first is void (C4).
5. A code email is delayed past its expiry: the worker does not send it (E2); the customer requests a new one.
6. SMTP down: emails stay `pending` with retries; code emails expire unsent; Sentry alerts. Sign-up still succeeds; the customer can resend later.
7. Someone registered the customer's email and never verified it: the real owner of the address uses "forgot password", which verifies the address and sets their password (C7); the squatter's name and phone are then editable by the owner of the email.
8. Email change confirmed after the new address was taken by a new sign-up in between: the unique constraint refuses it with `EMAIL_TAKEN`; no account changes.
9. A test customer's email collides with a later real sign-up: impossible, emails are unique across customers; the real person gets the C2 behaviour and support resolves it.
10. Admin idle expiry while a form is open: the input is lost; the notice says why. Accepted.
11. Clock skew on TOTP: the plugin's default window (one step either side) applies.
12. A customer with the session list open signs out "this device" from it: treated as sign-out.
13. `REGISTRATION_OPEN` changed: takes effect at the API's next start (S05 makes it immediate).
14. Phone with spaces, leading `00`, or local `09…`: normalized to E.164 before validation; an invalid number is refused with the field error.
15. The production database holds the Phase 0 owner row in `staff_users`: the rename migration keeps it as the admin with its password and TOTP; its `role` value is dropped.

## Open questions
None blocking. Recorded for later:
- SMTP credentials for `info@vertexmedia.pro` and SPF, DKIM and DMARC on `vertexmedia.pro` (ADR 0007) must be ready before the Phase 1 production deploy; S01 works locally with file output.

## Acceptance
Owner's browser check (local, `pnpm dev`, `REGISTRATION_OPEN=true`, emails written to files):
1. Store: sign up with a Syrian number written as `09…`; the verification email file appears with a code; a wrong code shows the error; the right code signs you in.
2. Sign out, sign in again: a "new sign-in" email file appears.
3. Account page: change name and phone; change password (another browser's session ends); change email (code goes to the new address, notice to the old); see sessions from two browsers and sign the other out; "sign out everywhere".
4. Forgot password: request, enter code and new password, sign in with it.
5. Sign up again with the same email: the same "code sent" screen; the attempt-notice email file appears for the existing account.
6. Set `REGISTRATION_OPEN=false`, restart: the sign-up link disappears and the route shows the closed message.
7. Panel: on a fresh local database run `admin:create`; sign in with the printed password → forced new password → TOTP enrolment; a second `admin:create` is refused.
8. Run `admin:reset-password`: the panel session ends; sign in with the new password (TOTP still asked), change it.
9. Leave the panel idle for 30 minutes (or a shortened value in a test build): the next action returns to sign-in with the idle notice.
10. Create a test customer, sign in with it in the store; open the audit log and filter by customer, action and the test customer's id; every step above is there with before and after.

Tests:
- Rename: every Phase 0 staff test passes under the admin names; no `staff` identifier, table, permission or role remains in `apps/` and `packages/` (a grep test in the architecture tests); the migration renames tables in place (a test inserts a staff row before and finds it as the admin after).
- API: every route for success and 401; admin routes refuse customer sessions and customer routes refuse admin sessions; `PASSWORD_CHANGE_REQUIRED`, `TWO_FACTOR_REQUIRED`, `SESSION_IDLE_EXPIRED`, `REAUTHENTICATION_REQUIRED` (missing and older than 5 minutes, through a test-only sensitive route); a customer can list and revoke only their own sessions; test-customer reset refuses a real customer.
- Enumeration: sign-up, code send, password reset and email change give identical status and body for existing and unknown emails.
- Limits: code send limits per email and per IP survive an API restart; the 6th wrong OTP voids the code; ALTCHA required after 3 failed sign-ins.
- Concurrency: two concurrent `admin:create` runs leave one admin; a direct insert of a second `admin_users` row fails; concurrent email-change confirmations to one address leave one winner.
- Audit: each action writes exactly one entry in the same transaction (rolled back with a failed change); `UPDATE` and `DELETE` on `audit_entries` fail as the app role; `details` never contains password, OTP or token fields (schema test over every action).
- Worker: `email.send` twice for one row sends once; expired code emails are not sent; params cleared after send; local mode writes a file.
- Unit: `passwordSchema`, `adminPasswordSchema` (common list, email equality, lengths), `phoneSchema` (Syrian local and international forms to E.164, invalid numbers), `fullNameSchema`.
- E2E with RTL screenshots in both themes (panel) and the store's dark theme at phone width: sign-up, verify email, forgot password, account page; panel change-password, account, re-auth dialog, audit log with the detail sheet, test customers.
