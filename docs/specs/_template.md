# <ID> — <Feature name>

Status: Draft | Approved · Date: YYYY-MM-DD · Scope: `docs/product/v1-scope.md` §<ID> · ADRs: <list>

## Summary
Two or three sentences: the problem this solves for customers or staff and what V1 of the feature does.

## In scope / out of scope
- In: …
- Out (later or never): …

## Roles and access
| Action | Route kind | Who |
|---|---|---|
| Create a deposit | Customer | Verified customer, not frozen |
| Approve a deposit | Staff `deposits.review` | Owner, manager, deposit reviewer |

## Data
For each entity: table, fields (name, type, required, constraints), relations, indexes, unique keys (idempotency keys and external references), and whether it is archived or append-only. Money fields name their currency and unit (ADR 0003).

## States and rules
States and allowed transitions (who or what triggers each, what happens). Business rules as numbered, testable statements.

## Money flows
For every event that moves money: the journal and its postings (accounts, amounts, currency), the idempotency key, the rate stored, and what reverses it. "None" if the feature moves no money.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `POST /api/deposits` | Customer, `Idempotency-Key` | `createDepositSchema` | `depositSchema` | `ACCOUNT_FROZEN`, `LIMIT_EXCEEDED` |

## Jobs and integrations
Worker jobs (queue, trigger, retries, what makes them safe to run twice); supplier, blockchain, email, push and Telegram calls.

## Screens
For each screen (store or admin): route, purpose, content and actions, and its loading, empty and error states. Phone width first for the store. Note what each role sees differently.

## Audit and notifications
Which changes write audit entries; which events notify whom, on which channel (email, push, Telegram, in-app).

## Abuse and fraud
How this feature can be abused (bots, replays, double submits, races, stolen sessions, forged receipts or webhooks) and the control for each: rate limit, ALTCHA, idempotency, unique index, lock, limit, flag.

## Edge cases
Numbered list: concurrent actions, supplier or chain timeouts, price or rate changes mid-flow, frozen customers, archived references, empty data, limits.

## Open questions
Anything not yet decided, with a recommendation. Nothing here may be guessed during implementation.

## Acceptance
- End-to-end check the owner runs in the browser, step by step (with the fake supplier and test data).
- Tests: API (success, 401, 403, other customers' records per endpoint), unit (rules and money math), concurrency and idempotency for money paths, E2E and RTL screenshots (screens).
