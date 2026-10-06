---
name: supplier-adapter
description: Add or change a supplier adapter in packages/suppliers (SHOP2TOPUP, WDGZone or a new supplier) behind the SupplierAdapter interface — documented endpoints, Zod response schemas, outcome and error classification, idempotency, webhook HMAC verification, sanitized fixtures and tests that never call the live service. Use when a supplier is added or its API changes.
argument-hint: <supplier code, e.g. shop2topup>
disable-model-invocation: true
effort: high
---

Build or change the adapter for **$ARGUMENTS**. Rules: ADR 0005 (suppliers and routing), ADR 0004 (outcomes and idempotency), ADR 0008 (webhooks, secrets), `packages/suppliers/CLAUDE.md`.

## 0. Preconditions (stop and ask the owner if one fails)
- The supplier's API documentation is available (a link or files the owner provides). Never guess an endpoint, field or error code: an unknown is a question for the owner or the supplier.
- No real API key is needed to build: the adapter is written and tested against fixtures. Never ask the owner to paste a key into the chat, a file or a command; keys are entered in the admin panel.
- The branch is not `main`: `feat/supplier-<code>`.

## 1. Document
Write or update `docs/suppliers/<code>.md`: base URL, authentication header format, endpoints used (list offers, balance, validate player, place order, get order, webhooks), request and response fields, idempotency mechanism, status values and their mapping, error codes and their class, rate limits, timeouts, IP allowlist, webhook signature scheme (header names, signed payload, algorithm, timestamp), refund behavior, and quirks. Mark anything the docs do not say as an open question in that file.

## 2. Build in `packages/suppliers/src/<code>/`
- `schemas.ts`: Zod schemas for every response and webhook payload; unknown extra fields are tolerated, missing required ones fail parsing.
- `adapter.ts`: implements `SupplierAdapter` with its capability flags. Injected `fetch` and clock; per-call timeouts; credentials passed in by the caller, never read from the environment, never logged.
- **Idempotency:** `placeOrder` sends the attempt id as the supplier's idempotency key (`order_id`, `X-Idempotency-Key` or equivalent); a repeat with the same key must return the original order, never create a second one. If the supplier has no idempotency, stop and ask the owner: the adapter must then check for an existing order before placing.
- **Outcome classification** (`errors.ts`): every response maps to `delivered`, `pending`, `failed_definitive` or `unknown`. Timeouts, connection resets after the request was sent, 5xx and unparseable bodies on `placeOrder` are `unknown`, never `failed_definitive`. Errors before anything was sent (DNS, connection refused) are retryable. Keep the supplier's raw code and message.
- **Money:** costs parsed from decimal strings into integer micro-dollars without floats; reject negative or non-numeric prices; currency checked.
- **Webhooks:** `verifyWebhook` with HMAC over the exact raw body, timing-safe compare, timestamp tolerance; `parseWebhook` returns the supplier event id for replay protection.
- **Player validation** (when supported): returns valid, invalid or unavailable, with the in-game name when given; never throws for an invalid ID.
- Register the adapter in the supplier registry.

## 3. Test (no live calls)
- `fixtures/`: request and response samples from the documentation, or recorded from a sandbox, **sanitized** (no keys, signatures from a test secret, no real player names or ids, no real order ids).
- Tests against a local fake HTTP server: each endpoint's happy path; every status and error code mapped to the right outcome; timeout and 5xx after send → `unknown`; repeat `placeOrder` with the same key → same order; webhook with a valid, a wrong and a stale signature, and a replayed event id; decimal prices to micro-dollars at the edges.
- If the fake supplier lacks a scenario this supplier can produce, add it to the `fake` adapter so the order engine is tested against it too.
- Gates through the `checker` subagent: `suppliers` test and typecheck, then the `worker` tests that use the registry.

## 4. Live smoke test (only with the owner)
A live call costs money and uses real keys, so it never runs from tests or CI. When the owner asks, give them the CLI command to run themselves on the server or a trusted machine (`supplier:smoke <code>`: balance, list offers, validate a known test ID, and one smallest order only if the owner says so), and read back only the summary they share.

## 5. Close
- Update `docs/architecture.md` if capabilities changed and the "Patterns to copy" table in `.claude/skills/feature-slice/wiring.md` for the first adapter.
- `reviewer` subagent, then `/ship`.
