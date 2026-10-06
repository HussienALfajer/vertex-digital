# 0007 — Authentication: customers and staff are separate

Status: Accepted · Date: 2026-10-06

## Context
Customers sign up themselves and need a low-friction, free verification. Staff can move money and see personal data, so a stolen staff password must not be enough. SMS OTP costs money per message in Syria; email is free. The admin panel lives on its own host.

## Decision

### Customers
- **Better Auth**, instance mounted at `/api/auth` on the store host. Email + password; the email is verified by a **6-digit email OTP** (Better Auth email OTP plugin) before the account can deposit or buy. Password reset by email OTP.
- Required at sign-up: full name and **phone number**. The phone field defaults to Syria (+963, mobile format `09xxxxxxxx`) and allows other countries; it is validated by format (libphonenumber) and stored in E.164. It is **not** OTP-verified (owner, 2026-10-06). Further profile fields are decided in the F01 spec.
- Email is sent over SMTP from a `vertexmedia.pro` mailbox, initially `info@vertexmedia.pro` (owner, 2026-10-06), configured by `EMAIL_FROM` so it can change without code. All email goes through the outbox and the worker; OTP codes are queued with top priority so they arrive at once, and the API never waits on SMTP.
- ALTCHA challenge on sign-up, sign-in after failures, OTP requests and password reset (ADR 0008). Per-email and per-IP rate limits on every auth endpoint.
- Sessions in PostgreSQL; `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`, host-only on `digital.vertexmedia.pro`. Customers see active sessions and can sign out everywhere.

### Staff
- A **second Better Auth instance** with its own tables (`staff_*`), mounted at `/api/admin/auth`, reachable only through the admin host. No self sign-up: the owner creates staff (CLI for the first owner, then the panel).
- **TOTP 2FA is mandatory**: until a staff member enrols, every staff route answers `TWO_FACTOR_REQUIRED`. Backup codes are issued at enrolment; a reset is done by the owner (or by CLI on the server for the owner).
- Shorter sessions (idle timeout and absolute lifetime set in the F02 spec), host-only cookie on `digital-admin.vertexmedia.pro`.
- **Re-authentication** (password + TOTP within the last few minutes) for sensitive actions: refunds above a limit, wallet adjustments, exchange rate changes, supplier keys, staff and role changes.
- Roles: owner, manager, order operator, deposit reviewer, support. Permissions are a map in `packages/contracts`, enforced by API guards; services apply any scope as query filters.
- Telegram linking: a staff member links their Telegram account with a one-time code shown in the panel; Telegram actions are limited (ADR 0006) and audited with the channel.

### Separation
- Staff routes are under `/api/admin/`. nginx on the store host answers `404` for `/api/admin/`; the API also refuses a staff route when the request's origin is not the admin host and refuses customer sessions on staff routes (and the reverse).
- A person who is both staff and customer has two accounts.

## Consequences
- A leaked customer session can never act on the panel, and a staff password alone opens nothing.
- Two auth configurations to maintain; both live in the API's `auth` and `staff` modules with shared tests.
- Email deliverability matters (SPF, DKIM, DMARC on `vertexmedia.pro`), checked before launch.
