# 0016 — One admin account, no staff or roles

Status: Accepted · Date: 2026-10-07 · Amends [0003](0003-money-currencies-and-ledger.md), [0004](0004-orders-and-fulfilment-state-machine.md), [0005](0005-supplier-adapters-and-routing.md), [0006](0006-payments-and-deposits.md), [0007](0007-auth-customers-and-staff.md), [0011](0011-engineering-conventions.md)

## Context
The V1 scope planned staff accounts with five roles (owner, manager, order operator, deposit reviewer, support) and a permission map. The owner runs the store alone in V1 (owner, 2026-10-07). Roles, staff management screens and permission checks would add code, tests and attack surface that nobody uses.

## Decision
- **One admin account** with full access to the panel and every admin route: the owner. There are no staff accounts, roles, permissions or staff management screens. The database allows at most one admin row.
- **Created and recovered on the server only:** `admin:create` (refuses when an admin exists), `admin:reset-password` and `admin:reset-two-factor` print a generated password or clear TOTP; a CLI-issued password must be changed at the next sign-in. There is no reset by email or from the panel. Every CLI run writes an audit entry.
- **Protections stay as in ADR 0007** (owner, 2026-10-07): separate Better Auth instance and tables, admin host only, mandatory TOTP with backup codes, 30-minute idle timeout and 12-hour absolute session, re-authentication (password + TOTP within 5 minutes) for sensitive actions, and an audit entry for every money action and every admin action.
- **Naming:** `staff` becomes `admin` in code, tables, routes' internals, CLI scripts and environment variables (`admin_users`, `@AdminRoute()`, `ADMIN_AUTH_SECRET`), done by the S01 implementation. Admin routes stay under `/api/admin/`.
- **Access in code (amends 0011):** `@AdminRoute()` takes no permissions; the guard checks a signed-in admin with TOTP enrolled and no pending password change. Tests check 401 and the customer/admin separation instead of per-role 403s.
- **Work earlier documents gave to roles** (deposit review, order operations, refunds, support replies, settings, supplier keys, exchange rate, wallet adjustments, code reveal) is the admin's. Where an ADR says "owner or manager permission", "staff", "operator" or "reviewer", read "the admin" (amends 0003, 0004, 0005, 0006, 0007).
- **Telegram (F07):** links the admin's account; deposit cards and every alert go to the admin. The Telegram approval limits of ADR 0006 remain.

## Consequences
- Less code, fewer screens and no privilege-escalation surface inside the panel.
- One person is the only reviewer for Sham Cash deposits and exceptions: the customer-facing review ETA must reflect the owner's working hours (Q9).
- A stolen admin session reaches everything, so TOTP, short sessions and re-authentication carry the whole weight; losing both the TOTP device and the backup codes needs server access to recover.
- Adding staff later needs a new ADR that brings back roles; `audit_entries` already records the actor's id, so more than one admin fits without changing past entries.
