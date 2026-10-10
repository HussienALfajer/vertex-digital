# S12 — Customers and support (F19, F23)

Status: Approved · Date: 2026-10-10 · Scope: `docs/product/v1-scope.md` §F19, §F23 (F27 ticket replies) · ADRs: 0003, 0004, 0006, 0007, 0011, 0016, 0018, 0019, 0023, 0024, 0026

## Summary
The admin can see a customer only through a deposit, an order or a wallet page, and has no way to stop a suspicious account, raise a trusted customer's limits or answer a question inside the system; customers ask "where is my order?" in outside chats. S12 adds **customers administration**: search, a customer profile (wallet, orders, deposits, tickets, devices and sign-ins, notes, fraud signals, history), **freezing** (no new deposits or purchases, balance kept), per-customer **limit overrides** (per deposit, daily deposits, an optional daily purchase cap), **archiving** a closed account with a zero balance, and signing a customer out everywhere. It adds **support tickets**: a customer opens a ticket of a type, linked to one of their orders or deposits when it is about one, with up to 3 images per message; the admin answers from the panel, can open a ticket to a customer, and gets a Telegram message; the customer gets a notification and an email on each reply. One Telegram support link, set in the panel, is shown on the store (owner, 2026-10-10; Q14).

## In scope / out of scope
- In:
  - Admin customer list with search and status filters; the customer profile with its tabs.
  - Freeze and unfreeze (rules CF); per-customer limit overrides (rules LM); archive and unarchive (rules AR); sign out all of a customer's sessions.
  - The sign-in log (`customer_sign_ins`) for devices and the shared-IP signal; the shared-phone signal.
  - Admin notes on a customer, with one pinned note shown on the customer's deposit and order pages in the panel.
  - Support tickets: store pages (list, new, thread), the admin queue and thread, admin-opened tickets, attachments, auto-close, limits.
  - Notifications: `ticket_replied` to the customer (center and email, F27); Telegram `ticket_opened` and `ticket_reply` to the admin; the dashboard attention item and the daily summary line.
  - The support settings (Telegram link) and the store's support entry points (footer, order and deposit pages).
- Out (later or never):
  - Editing a customer's name, phone or email from the panel: never in V1 (owner, 2026-10-10); the customer edits their own (S01).
  - A global daily purchase cap: never in V1 (owner, 2026-10-10; S08 keeps no amount cap). The cap exists per customer only.
  - Automatic freezing from fraud signals: not in V1; signals are shown, the admin decides.
  - Shared player IDs as a fraud signal: not in V1 (owner, 2026-10-10).
  - Replying to tickets from Telegram: not in V1 (owner, 2026-10-10); Telegram only tells the admin.
  - Live chat, canned replies, ticket assignment, satisfaction ratings, PDF or video attachments: not in V1.
  - Web push for ticket replies: S15 (F24).
  - A WhatsApp link: not in V1 (owner, 2026-10-10).
  - Customer self-deletion: never (S01); the customer asks in a ticket and the admin archives.
  - The admin's view of a customer's saved player IDs: not in V1.

## Access
| Action | Route kind | Who |
|---|---|---|
| List, open, reply to and close own tickets; open a ticket (types, links, images); read own attachments | Customer | Verified customer, frozen allowed, not archived |
| Read the support channels (Telegram link) | Public | Anyone |
| Search customers, read a profile and its tabs, read notes and sign-ins | Admin | The admin |
| Add, pin, unpin and archive a note | Admin | The admin |
| Freeze, unfreeze, change limits, archive, unarchive, sign out everywhere | Admin, re-authentication | The admin |
| Read the ticket queue and a ticket; reply; open a ticket to a customer; close and reopen | Admin (`Idempotency-Key` on posts) | The admin |
| Change the support settings | Admin, re-authentication | The admin |
| Auto-close answered tickets, purge old sign-ins, send Telegram ticket messages | Worker jobs | System |

Admin routes live under `/api/admin/` with the TOTP-complete admin session (ADR 0016); customer routes refuse admin sessions and the reverse (S01 C17). A customer only ever reaches their own tickets, messages and attachments: every query filters by the session's customer, and another customer's id answers `NOT_FOUND`.

## Data
Money is USD units (micro-dollars, ADR 0003). The `auth` module owns the customer tables (S01); a new api `customers` module (admin administration) owns `customer_limits` and `customer_notes`; a new api `support` module owns the ticket tables and `support_settings`.

### Contracts (`customers.ts`, `support.ts` new, `deposits.ts`, `orders.ts`, `notifications.ts`, `telegram.ts`, `dashboard.ts`, `audit.ts`, `errors.ts` extended)
- `CUSTOMER_STATUSES` (`active`, `frozen`, `archived`) and `customerStatus(customer)`: `archived` when `archived_at` is set, else `frozen` when `frozen_at` is set, else `active`. The list filter adds `test`.
- `customerSearchQuerySchema` (`q?` 1–100, `status?` `all` default | `active` | `frozen` | `archived` | `test`, cursor), `adminCustomerRowSchema`, `adminCustomerPageSchema`, `adminCustomerSchema` (profile), `customerSignalsSchema`, `customerLimitsSchema`, `updateCustomerLimitsSchema`, `customerStateChangeSchema` (`reason` 5–500), `customerNoteSchema`, `createCustomerNoteSchema` (`body` 1–2000, `pinned?`), `customerSignInSchema`.
- `effectiveDepositLimitSettings(settings, override)` (rule LM2) and `purchaseCapBreach(capUnits, usedUnits, newUnits)` (rule LM4), pure, 100% coverage.
- `TICKET_CATEGORIES` (`order`, `deposit`, `account`, `other`), `TICKET_STATUSES` (`open`, `answered`, `closed`), `TICKET_AUTHORS` (`customer`, `admin`), `TICKET_CLOSERS` (`customer`, `admin`, `system`); `ticketSubjectSchema` (3–120 after trimming), `ticketBodySchema` (1–2000 after trimming, no control characters except newlines), `createTicketSchema`, `adminCreateTicketSchema`, `ticketMessageSchema`, `ticketSchema`, `ticketPageSchema`, `adminTicketSchema`, `adminTicketPageSchema`, `supportChannelsSchema`, `supportSettingsSchema`; `ticketTransition(status, event)` and `customerCanReply(ticket, now)` (rules TK3–TK6), pure, 100% coverage.
- `TICKET_LIMITS`: 3 open tickets per customer, 5 tickets created per 24 hours, 20 messages an hour, 3 images per message, 5 MB per image, 7 days to auto-close and to reopen.
- `STORED_FILE_KINDS` gains `ticket_attachment`.
- `NOTIFICATION_EVENTS` gains `ticket_replied` (params `ticketId`, `number`; never the message), with its email template and preference (on by default, S05).
- `TELEGRAM_MESSAGE_KINDS` gains `ticket_opened` and `ticket_reply`.
- `ATTENTION_KINDS` gains `tickets_waiting` (S11 DB6).
- Error codes, each with its Arabic text: `ACCOUNT_FROZEN` (403), `PURCHASE_LIMIT_EXCEEDED` (409, `details.limitUnits`, `details.remainingUnits`), `CUSTOMER_STATE_INVALID` (409, `details.status`), `CUSTOMER_NOT_ARCHIVABLE` (409, `details.blockers`: `balance`, `open_orders`, `open_deposits`), `TICKETS_LIMIT_REACHED` (409, `details.limit`: `open` or `daily`), `TICKET_ALREADY_OPEN` (409, `details.ticketId`), `TICKET_CLOSED` (409), `TICKET_LINK_INVALID` (400: a link missing for its type, present for another type, or not the customer's); existing `REAUTHENTICATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `NOT_FOUND`, and the upload errors the receipt route already uses (`IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`).

### `customers` (S01; changed by migration)
- `frozen_at` timestamptz nullable: set while the customer is frozen. The reason and history live in the audit log (`customer.frozen`, `customer.unfrozen`).
- `archived_at` (exists): set by the admin (rules AR); S01 already refuses sign-in, OTP and password reset for an archived account.
- Index on `lower(name) text_pattern_ops` is not needed at V1 sizes; search uses the rules in CS1 on the existing unique email and phone index.

### `customer_sign_ins` (new; owner: `auth`)
- `id` uuid v7; `customer_id` uuid FK `customers`; `ip_address` text nullable; `user_agent` text nullable (≤ 500); `created_at`.
- Written in the transaction that creates a customer session (sign-in, sign-up verification, password reset sign-in), from the same IP and user agent the session stores.
- Indexes: `(customer_id, created_at desc)`, `(ip_address, created_at desc)`.
- Kept 90 days: a daily job deletes older rows (not business records: no audit, no money).

### `customer_limits` (new; owner: `customers`)
- `customer_id` uuid PK FK `customers`; `per_deposit_usd_units` bigint nullable; `daily_deposit_usd_units` bigint nullable; `daily_purchase_usd_units` bigint nullable; `updated_at`.
- Checks: each set value `> 0`, whole cents (`% 10000 = 0`), at most $100,000; `per_deposit ≤ daily_deposit` when both are set.
- A null column means "the store default" (the S03 tier for deposits; no cap for purchases). A missing row means all null. Changes are audited with before and after (rule LM5).

### `customer_notes` (new; owner: `customers`)
- `id` uuid v7; `customer_id` uuid FK; `body` text 1–2000; `pinned` boolean default `false`; `created_at`; `archived_at` nullable.
- Partial unique index on `customer_id` where `pinned and archived_at is null`: at most one pinned note. `body` never changes (trigger refuses updates of `body` and `customer_id`); only `pinned` and `archived_at` change. No delete (archive, don't delete).

### `support_tickets` (new; owner: `support`)
- `id` uuid v7; `number` text unique, `^VT-[2-9A-HJKMNP-Z]{6}$` (the order number alphabet); `customer_id` uuid FK; `category` enum `ticket_category`; `order_id` uuid nullable FK `orders`; `deposit_id` uuid nullable FK `deposits`; `subject` text 3–120; `status` enum `ticket_status`; `opened_by` enum `ticket_author`; `last_customer_message_at` nullable; `last_admin_message_at` nullable; `closed_at` nullable; `closed_by` enum `ticket_closer` nullable; `created_at`; `updated_at`.
- Checks: `category = 'order'` ⇔ `order_id` set; `category = 'deposit'` ⇔ `deposit_id` set; never both; `status = 'closed'` ⇔ `closed_at` and `closed_by` set.
- Partial unique indexes where `status <> 'closed'`: on `order_id`, on `deposit_id` (one open ticket per order or deposit).
- Indexes: `(customer_id, updated_at desc)`; `(status, last_customer_message_at)` for the queue; `(status, last_admin_message_at)` for auto-close.

### `support_messages` (new; owner: `support`)
- `id` uuid v7; `ticket_id` uuid FK; `author` enum `ticket_author`; `body` text 1–2000; `idempotency_key` text nullable; `created_at`.
- Unique `(ticket_id, author, idempotency_key)`. Append-only: a trigger refuses UPDATE and DELETE (a ticket's conversation is a record).
- Index `(ticket_id, created_at)`.

### `support_attachments` (new; owner: `support`)
- `message_id` uuid FK; `file_id` uuid FK `stored_files`, unique; `position` smallint 1–3. Primary key `(message_id, position)`. Append-only.

### `support_settings` (new; owner: `support`)
- Single row (`id = 1`); `telegram_url` text nullable, `^https://t\.me/[A-Za-z0-9_]{5,32}$`; `updated_at`. Seeded empty.

### `stored_files` (S03; changed)
- Kind `ticket_attachment`: JPEG, PNG or WebP in, at most 5 MB in, re-encoded like a deposit receipt (sharp, 40 MP input limit, metadata stripped, fit in 2000 px, WebP). Served with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` only to the ticket's customer and the admin.

## States and rules

### Customer search and profile
- CS1. **Search** (`GET /api/admin/customers`): `q` matches, in this order of precedence: an order number (`VO-…`, exact, case-insensitive) → its customer; a deposit reference (`VD-…`) → its customer; a ticket number (`VT-…`) → its customer; text with `@` → email prefix (lowercased); text of digits, spaces and `+` with at least 6 digits → phone, normalized to E.164 when it parses (Syria by default, S01) and matched exactly, else matched as a suffix of the stored phone; anything else → name contains (case-insensitive) or email contains. Results newest first, cursor pages of 25 (ADR 0011 lists). Status filter by `customerStatus`; `test` shows test customers only.
- CS2. **Row:** name, email, phone, created at, status chips (frozen, archived, test), balance (S02 ledger sum, read in one query for the page), delivered orders count, last order at.
- CS3. **Profile** (`GET /api/admin/customers/:id`): identity (name, email, phone, verified, test, created at, account age, new or established by S03 SC3), status with the last freeze or archive reason and time (from the audit log), the effective limits with their source (rule LM3), the pinned note, the balance, counts (delivered orders and their total, refunded orders, credited deposits and their total, open tickets, active sessions) and the signals (CS5).
- CS4. **Tabs** read their own routes, each a cursor page: orders (the S08 admin list filtered by `customerId`), deposits (the S03 list filtered by `customerId`, both methods), tickets, devices (active sessions with browser and system, IP, created, last active; and the last 50 sign-ins), notes, history (audit entries whose entity is this customer, its orders, its deposits or its tickets, newest first). The wallet tab links to the S02 wallet page `/wallets/$customerId`.
- CS5. **Signals** (owner, 2026-10-10), shown, never acted on automatically:
  - shared phone: other customers with the same E.164 phone (count and up to 10 with links), S01 C6;
  - shared IP: other customers with a sign-in from an IP this customer signed in from in the last 30 days (count, up to 10 customers with the shared IPs, links). IPs are compared exactly; the panel notes that Syrian networks often share an IP, so it is a hint, not proof.
- CS6. The pinned note, the status (frozen, archived) and the signals count also appear in the customer panel of the S03 deposit review page and of the S08 admin order page.

### Freezing (owner, 2026-10-10)
- CF1. **Freeze** (`POST /api/admin/customers/:id/freeze`, re-authentication, reason 5–500), one transaction: lock the customer row `FOR UPDATE`; refuse an archived or already frozen customer (`CUSTOMER_STATE_INVALID`); set `frozen_at`; cancel every `awaiting_balance` order of the customer with `cancelReservation` and the new reason `frozen` (no money was taken; the customer gets `order_cancelled` as S09); write the audit entry.
- CF2. **What a frozen customer cannot do** (`ACCOUNT_FROZEN`): create a deposit (Sham Cash or USDT); place an order, pay a checkout, create a reservation (S08 O1, S10 checkout, S09); check a player ID (S09, it spends supplier quota). Each of these reads the customer row `FOR SHARE` inside its own transaction, before any write, so a freeze and a purchase never interleave: whichever commits first wins.
- CF3. **What still works:** signing in and every read page; uploading a receipt or a TXID for a deposit created before the freeze (the customer may already have paid; the admin decides); revealing delivered codes, gift and receipt links, saved player IDs, notifications, the account page; support tickets (CF5).
- CF4. **Money already moving continues** (ADR 0004): paid orders are fulfilled, retried and refunded as usual; USDT that arrives is credited (S04 edge 14); a submitted Sham Cash deposit stays in the queue and the admin may approve it **in the panel only**: the Telegram card shows "العميل مجمّد" and has no Approve button, and an Approve pressed on an older card is refused with that text (S05 TG rules). Admin wallet adjustments work (S02).
- CF5. **What the customer sees:** a banner on every store page while signed in: "حسابك موقوف مؤقتاً: لا يمكنك الإيداع أو الشراء حالياً. تواصل مع الدعم." with a link to `/support/new?category=account`. The reason is never shown. Buy, cart, deposit and player-check controls are disabled with the same sentence; the API's `ACCOUNT_FROZEN` text says the same. The customer's session payload carries `frozen: true` (as S01 maps `archived`). No email or notification is sent for a freeze or unfreeze.
- CF6. **Unfreeze** (`POST …/unfreeze`, re-authentication, reason): lock, refuse when not frozen (`CUSTOMER_STATE_INVALID`), clear `frozen_at`, audit. Cancelled reservations stay cancelled.
- CF7. Test customers can be frozen like any customer.

### Limits (owner, 2026-10-10)
- LM1. Per customer, the admin may override the **per-deposit** and **daily deposit** limits and set a **daily purchase cap**. Each is optional; clearing it returns to the default.
- LM2. **Deposits:** `effectiveDepositLimitSettings` replaces the tier's per-deposit and daily values (new or established, S03 SC3) with the override when set; the minimum (Sham Cash $2, USDT $5) is unchanged. Everything else in S03 SC3 and S04 (the shared 24-hour window, `depositLimitBreach`, the wizard's display of the limits and of what remains today) reads the effective values. An override may be lower or higher than the tier.
- LM3. The profile shows each limit's effective value and its source ("الافتراضي: حساب جديد"، "الافتراضي: حساب موثوق"، "مخصّص").
- LM4. **Daily purchase cap:** when set, the sum of the customer's purchases in the last 24 hours plus the new one may not exceed it. Purchases = Σ over the customer's orders with `paid_at > now − 24h` of `quantity × unit_price_usd_units − refunded_usd_units`. Checked in the purchase transaction (after the customer `FOR SHARE` of CF2): an order (`PURCHASE_LIMIT_EXCEEDED` with the cap and what remains), a checkout by its whole total (all or nothing, S10), and a reservation's payment, which is **skipped** while it would exceed the cap and stays `awaiting_balance` until it fits or expires (as S09 skips what the balance cannot cover). Creating a reservation whose total alone is above the cap is refused with the same code. Test customers follow it too.
- LM5. **Change** (`PUT /api/admin/customers/:id/limits`, re-authentication, reason 5–500): upserts the row in one transaction with an audit entry holding before and after. Allowed for a frozen customer, refused for an archived one (`CUSTOMER_STATE_INVALID`).
- LM6. The customer is not told when their limits change; the deposit wizard simply shows the new values, and the cap appears only in a refusal.

### Archiving (owner, 2026-10-10)
- AR1. **Archive** (`POST …/archive`, re-authentication, reason 5–500), one transaction: lock the customer row `FOR UPDATE` and the wallet; refuse an archived customer (`CUSTOMER_STATE_INVALID`); refuse with `CUSTOMER_NOT_ARCHIVABLE` and every blocker when the wallet balance is not zero (`balance`), any order is `awaiting_balance`, `paid`, `sent_to_supplier`, `failed` or `needs_review` (`open_orders`), or any deposit is `pending` or `submitted` (`open_deposits`, both methods).
- AR2. **Effects:** set `archived_at`; delete every customer session; close the customer's open tickets (`closed_by = 'system'`); audit. The email stays taken (unique); the customer cannot sign in, receive an OTP or reset the password (S01). A frozen customer keeps `frozen_at` while archived. Share links stay valid (a gift already sent keeps working); the customer could revoke them before asking.
- AR3. **Unarchive** (`POST …/unarchive`, re-authentication, reason): lock, refuse when not archived, clear `archived_at`, audit. The customer signs in with their password or resets it.
- AR4. Money arriving for an archived customer (a late USDT transfer matched by TXID or by the admin) is credited as usual; the profile then shows a balance and the dashboard nothing special. The admin decides (unarchive, or an exceptional cash refund recorded as an adjustment, ADR 0003).

### Sessions and notes
- SN1. **Sign out everywhere** (`POST …/sessions/revoke`, re-authentication, reason): deletes every session of the customer; audit with the count. Allowed in every status.
- SN2. **Notes:** `POST …/notes` adds a note (optionally pinned, which unpins the current pinned one in the same transaction); `POST …/notes/:noteId/pin`, `…/unpin`, `…/archive`. No re-authentication (notes move nothing); each change audited. Notes are never shown to the customer and never sent to Telegram or email.

### Support tickets (owner, 2026-10-10)
- TK1. **Open by the customer** (`POST /api/support/tickets`, multipart, `Idempotency-Key`): `category`, `orderId` for `order`, `depositId` for `deposit`, none for the others (`TICKET_LINK_INVALID`, also when the order or deposit is not the customer's), `subject`, `body`, up to 3 images. Refused with `TICKETS_LIMIT_REACHED` when the customer already has 3 non-closed tickets they opened (`open`) or opened 5 in the last 24 hours (`daily`); with `TICKET_ALREADY_OPEN` and its id when the order or deposit already has a non-closed ticket. One transaction: number, ticket `open`, the first message and its attachments, `last_customer_message_at`, the Telegram `ticket_opened` message (TK8), audit `ticket.opened`. The same key and body return the first ticket.
- TK2. **Open by the admin** (`POST /api/admin/support/tickets`, `Idempotency-Key`): a customer (not archived), the same category and link rules (the link must be that customer's), subject, body, up to 3 images. The ticket starts `answered` with `opened_by = 'admin'`; the customer gets `ticket_replied`. It does not count toward the customer's limits in TK1, but the one-open-ticket-per-link rule applies.
- TK3. **States:** `open` (waiting for the admin) → `answered` (waiting for the customer) → `closed`. A customer message moves `open` or `answered` to `open`; an admin message moves `open` or `answered` to `answered`. Either side may close at any time.
- TK4. **Customer message on a closed ticket:** allowed within 7 days of `closed_at` and reopens it to `open`; later it answers `TICKET_CLOSED` and the page offers a new ticket with the same type and link. Reopening also needs the link's open-ticket slot to be free (otherwise `TICKET_ALREADY_OPEN`) and counts toward the 3 open tickets.
- TK5. **Admin message on a closed ticket:** allowed at any time; it reopens to `answered` (the link rule applies).
- TK6. **Auto-close:** an `answered` ticket with no customer message for 7 days after the last admin message is closed by the worker (`closed_by = 'system'`). No notification; the thread shows "أُغلقت تلقائياً لعدم الرد".
- TK7. **Messages** (`POST …/tickets/:id/messages`, multipart, `Idempotency-Key`): body and up to 3 images (a message with images only needs a body of at least 1 character: the UI fills "صورة مرفقة" when empty). 20 messages an hour per customer (`RATE_LIMITED`). The admin's messages have no rate limit. Text is shown as plain text everywhere (no HTML, no Markdown, no auto-linking on the store; the panel shows URLs in customer text as plain, non-clickable text to avoid phishing clicks).
- TK8. **Telegram to the admin** (owner, 2026-10-10): `ticket_opened` for every customer-opened ticket, and `ticket_reply` for a customer message, at most one per ticket per 10 minutes (`dedupe_key` `ticket:<id>:<10-minute bucket>`). Content: the number, the type in Arabic, the subject (escaped, cut to 120), whether it has images, the customer's email, and an "افتح في اللوحة" link to `/support/$id`. Never the message body or images. Written in the transaction, sent by the existing Telegram worker; with no linked chat it is skipped (S05).
- TK9. **Customer notification** (F27): every admin message (including the first message of an admin-opened ticket) writes `ticket_replied` through `notifyCustomer` (center and SSE always). The email (template `ticket_replied`, the ticket number and a link, never the reply text) is sent at most once per ticket per 10 minutes, and only when the customer's preference is on (default on).
- TK10. **Archived or frozen:** a frozen customer uses tickets normally. An archived customer cannot sign in; their tickets are closed at archive (AR2). The admin cannot open a ticket to an archived customer (`CUSTOMER_STATE_INVALID`).
- TK11. **Attachments:** each image re-encoded on upload inside the message request (S03's receipt pipeline), stored as `ticket_attachment` files linked to the message; at most 3 per message, 5 MB each. `GET /api/support/tickets/:id/attachments/:fileId` (customer, own ticket) and `GET /api/admin/support/tickets/:id/attachments/:fileId` (admin) serve them with `no-store` and `nosniff`; any other combination answers `NOT_FOUND`.
- TK12. **Reads:** the customer's list (own tickets, newest activity first, status and whether the last message is the admin's), the thread (messages oldest first). The admin's queue: tabs "بانتظار ردّك" (`open`, oldest customer message first), "بانتظار العميل" (`answered`), "مغلقة", "الكل"; filters by type and by customer; search by ticket number. Each row: number, customer, type, link (order or deposit number), subject, status, last activity, a frozen chip.
- TK13. **Admin badge and attention:** the navigation shows the `open` count on "الدعم"; the dashboard gains `tickets_waiting` (count and oldest `last_customer_message_at`, → `/support`); the daily summary (S05 AL3) adds "تذاكر جديدة اليوم" and "بانتظار ردّك الآن".

### Support channels (owner, 2026-10-10; Q14)
- SC1. `support_settings.telegram_url`, edited on `/settings/support` (re-authentication, audit `support.settings_changed` with before and after). Empty hides the link everywhere.
- SC2. `GET /api/support/channels` (public, `Cache-Control: public, max-age=60`) answers `{ telegramUrl }`. The store shows it on `/support` and in the footer ("تيليغرام الدعم"), opening in a new tab with `rel="noopener noreferrer"`.

### Audit
- AU1. New admin actions, in the transaction of the change: `customer.frozen`, `customer.unfrozen` (reason; cancelled reservation ids), `customer.limits_changed` (before and after per limit), `customer.archived`, `customer.unarchived`, `customer.sessions_revoked_by_admin` (count), `customer.note_added` (note id, pinned; never the body), `customer.note_pinned`, `customer.note_unpinned`, `customer.note_archived`, `ticket.opened_by_admin`, `ticket.replied`, `ticket.closed`, `ticket.reopened`, `support.settings_changed`. Customer actions: `ticket.opened`, `ticket.customer_replied`, `ticket.closed`, `ticket.reopened` (actor `customer`). System: `ticket.closed` (actor `system`, auto-close or archive). Audit details never hold a message body; they hold ids, the category and the status before and after.
- AU2. Reading a profile, the search and the tickets is not audited. Serving an attachment is not audited.

## Money flows
None new. Freezing, limits, archiving, notes and tickets move no money. Reservations cancelled by a freeze took no money (S09). The purchase cap only refuses or skips purchases; it never changes a posted journal. Archiving requires a zero balance and posts nothing. Credits that arrive later for a frozen or archived customer post the existing S03 and S04 journals.

## API
Responses `Cache-Control: no-store` except where stated.

| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/support/channels` | Public, `public, max-age=60` | — | `supportChannelsSchema` | — |
| `GET /api/support/tickets` | Customer | cursor | `ticketPageSchema` | `UNAUTHORIZED` |
| `POST /api/support/tickets` | Customer, `Idempotency-Key`, multipart | `createTicketSchema` + `files[]` | `201` `ticketSchema` (with messages) | `TICKETS_LIMIT_REACHED`, `TICKET_ALREADY_OPEN`, `TICKET_LINK_INVALID`, `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `RATE_LIMITED` |
| `GET /api/support/tickets/:id` | Customer | — | `ticketSchema` (with messages and attachment ids) | `NOT_FOUND` |
| `POST /api/support/tickets/:id/messages` | Customer, `Idempotency-Key`, multipart | `ticketMessageSchema` + `files[]` | `201` `ticketSchema` | `TICKET_CLOSED`, `TICKET_ALREADY_OPEN`, `TICKETS_LIMIT_REACHED`, `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `NOT_FOUND` |
| `POST /api/support/tickets/:id/close` | Customer | — | `ticketSchema` | `NOT_FOUND` (closing a closed ticket returns it unchanged) |
| `GET /api/support/tickets/:id/attachments/:fileId` | Customer | — | the image | `NOT_FOUND` |
| `GET /api/admin/customers` | Admin | `customerSearchQuerySchema` | `adminCustomerPageSchema` | `VALIDATION_FAILED` |
| `GET /api/admin/customers/:id` | Admin | — | `adminCustomerSchema` (CS3, CS5) | `NOT_FOUND` |
| `GET /api/admin/customers/:id/sign-ins` · `…/sessions` · `…/notes` · `…/history` | Admin | cursor | pages | `NOT_FOUND` |
| `GET /api/admin/orders?customerId=` (S08) · `GET /api/admin/deposits?customerId=` (S03) · `GET /api/admin/support/tickets?customerId=` | Admin | the filter added | unchanged | — |
| `POST /api/admin/customers/:id/freeze` · `…/unfreeze` · `…/archive` · `…/unarchive` · `…/sessions/revoke` | Admin, re-authentication | `customerStateChangeSchema` | `adminCustomerSchema` | `CUSTOMER_STATE_INVALID`, `CUSTOMER_NOT_ARCHIVABLE` (archive), `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `PUT /api/admin/customers/:id/limits` | Admin, re-authentication | `updateCustomerLimitsSchema` (three nullable limits, `reason`) | `customerLimitsSchema` | `CUSTOMER_STATE_INVALID`, `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/customers/:id/notes` · `POST …/notes/:noteId/pin` · `…/unpin` · `…/archive` | Admin | `createCustomerNoteSchema` · — | `customerNoteSchema` | `VALIDATION_FAILED`, `NOT_FOUND` |
| `GET /api/admin/support/tickets` | Admin | `status?`, `category?`, `customerId?`, `q?` (number), cursor | `adminTicketPageSchema` (with the `open` count) | `VALIDATION_FAILED` |
| `POST /api/admin/support/tickets` | Admin, `Idempotency-Key`, multipart | `adminCreateTicketSchema` + `files[]` | `201` `adminTicketSchema` | `CUSTOMER_STATE_INVALID`, `TICKET_ALREADY_OPEN`, `TICKET_LINK_INVALID`, `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `GET /api/admin/support/tickets/:id` | Admin | — | `adminTicketSchema` (messages, customer summary with status, pinned note and signals count, the linked order or deposit summary) | `NOT_FOUND` |
| `POST /api/admin/support/tickets/:id/messages` | Admin, `Idempotency-Key`, multipart | `ticketMessageSchema` + `files[]` | `201` `adminTicketSchema` | `TICKET_ALREADY_OPEN`, `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/support/tickets/:id/close` | Admin | — | `adminTicketSchema` | `NOT_FOUND` |
| `GET /api/admin/support/tickets/:id/attachments/:fileId` | Admin | — | the image | `NOT_FOUND` |
| `GET` · `PUT /api/admin/support/settings` | Admin; `PUT` re-authentication | — · `supportSettingsSchema` | `supportSettingsSchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED` |
| Customer purchase and deposit routes (S03, S04, S08, S09, S10) | unchanged | unchanged | unchanged | add `ACCOUNT_FROZEN`; the purchase routes add `PURCHASE_LIMIT_EXCEEDED` |
| `GET /api/auth/get-session` (S01) | unchanged | — | the user gains `frozen` | — |

Multipart uploads use the receipt route's size and type limits per file (5 MB, 3 files, 16 MB per request). The OpenAPI document and the admin client are regenerated.

## Jobs and integrations
- `support.auto_close` (worker, every hour): closes `answered` tickets past 7 days (TK6) with one `UPDATE … WHERE status = 'answered' AND last_admin_message_at < now() − 7 days` per batch of 100, each with its audit entry; safe to run twice (the status condition).
- `customers.purge_sign_ins` (worker, daily at 04:00 `Asia/Damascus`): deletes `customer_sign_ins` older than 90 days, in batches; idempotent.
- Telegram: two new message kinds through the existing outbox and sender (S05); rendering in the worker's Telegram templates.
- Email: the `ticket_replied` template through the outbox (S05), Arabic, plain, with the ticket number and a link to `/support/<id>`.
- The store's notification SSE (S05) already delivers `ticket_replied`; the thread page refetches on it.
- No supplier, chain or new external call.

## Screens

### Store (Arabic RTL, phone width first)
- **Global frozen banner** (CF5) on every page for a frozen signed-in customer; the buy box, cart, deposit wizard and player check show the disabled state and the sentence.
- **Footer:** "الدعم" (→ `/support`) and "تيليغرام الدعم" when set.
- **`/support` الدعم:** the Telegram card when set ("تواصل معنا على تيليغرام"); signed out: "سجّل الدخول لفتح تذكرة" with a sign-in link. Signed in: "تذكرة جديدة" and the list (number, subject, type, status chip "بانتظار الدعم" / "تم الرد" / "مغلقة", last activity, a dot when the last message is the admin's). Empty: "لا تذاكر بعد" with the button. Loading skeleton; error with retry.
- **`/support/new`:** type as four large choices ("طلب"، "إيداع"، "حسابي"، "أخرى"); for order and deposit, a picker of the customer's last 30 orders or deposits (number, product or method, amount, status), prefilled from `?order=` or `?deposit=`; subject; message with a counter; images (pick or camera, up to 3, previews, remove); "إرسال". Errors inline: the limit reached (with a link to the open tickets), already open (with a link to that ticket), file errors per image. Values kept on error.
- **`/support/$id`:** header with number, subject, type and link (to the order or deposit page), status; the thread (customer bubbles at the start side, the store's at the end side with "فريق VERTEX DIGITAL"), times, image thumbnails opening full size; the reply box with images; "إغلاق التذكرة" with a confirm; on a closed ticket: within 7 days the reply box says "ردّك سيعيد فتح التذكرة", later "هذه التذكرة مغلقة" with "فتح تذكرة جديدة" (prefilled type and link). Refetches on `ticket_replied`.
- **Order page and deposit page** (S08, S03, S04): "تحتاج مساعدة؟" opens the existing non-closed ticket for that order or deposit, or `/support/new` prefilled.
- **Notification center:** `ticket_replied` "ردّ فريق الدعم على تذكرتك VT-…" linking to the thread.
- **`/account`** email preferences gain "ردود الدعم".

### Admin (Arabic RTL, light and dark, desktop first)
- **Navigation:** "العملاء" (→ `/customers`) and "الدعم" (→ `/support`, with the `open` count badge). The S01 test customers page stays and is linked from the customers list.
- **`/customers`:** search box (one field, hint "الاسم، البريد، الهاتف، أو رقم طلب/إيداع/تذكرة"), status tabs (الكل، نشط، مجمّد، مؤرشف، تجريبي), the table (CS2) with cursor paging; search state in the URL. Empty: "لا عملاء مطابقون".
- **`/customers/$id`:** header with name, email, phone, chips (مجمّد، مؤرشف، تجريبي، جديد/موثوق), balance, and the actions menu: "تجميد" / "إلغاء التجميد"، "تعديل الحدود"، "تسجيل خروج من كل الأجهزة"، "أرشفة" / "إلغاء الأرشفة"، "فتح تذكرة"; each with its dialog (reason, re-authentication; archive lists the blockers when refused; freeze says reservations will be cancelled and how many). Tabs:
  - "الملخص": counts (CS3), effective limits with sources, the pinned note, signals (shared phone and shared IP lists with links and the NAT hint), the last freeze or archive reason.
  - "المحفظة": the balance and a link to the wallet page.
  - "الطلبات"، "الإيداعات"، "التذاكر": the existing lists filtered to the customer.
  - "الأجهزة": active sessions and the last 50 sign-ins (browser and system, IP, time).
  - "الملاحظات": add (with "تثبيت"), list newest first with pin, unpin and archive; archived notes behind "عرض المؤرشفة".
  - "السجل": the audit entries (CS4) with their Arabic labels.
  - Loading skeletons per tab; errors with retry.
- **S03 deposit page and S08 order page:** the customer panel gains the status chips, the pinned note and the signals count with a link to the profile.
- **`/support`:** the queue (TK12) with tabs and filters in the URL; rows open the thread. Empty per tab.
- **`/support/$id`:** the thread (customer messages at the start side), attachments, the reply box with images (Ctrl+Enter sends), "إغلاق" / reopen by replying; the side panel: customer summary (link to the profile, status chips, pinned note, signals), the linked order or deposit summary with its link, the ticket's history.
- **`/support/new?customer=<id>`** (from the profile): type, link picker of that customer's orders or deposits, subject, message, images.
- **`/settings/support`:** the Telegram link field with validation and a preview, re-authentication on save.
- Every error shows its code's translation; dialogs keep their values on error.

## Audit and notifications
- Audit: AU1, AU2.
- Customer: `ticket_replied` (center, SSE, email by preference, TK9); `order_cancelled` for reservations cancelled by a freeze (S09). Nothing for freeze, unfreeze, limits, archive or auto-close.
- Admin: Telegram `ticket_opened` and `ticket_reply` (TK8); the navigation badge, the dashboard's `tickets_waiting`, the daily summary lines (TK13); the S05 Telegram deposit card shows a frozen customer without Approve (CF4).

## Abuse and fraud
| Threat | Control |
|---|---|
| A customer under investigation keeps buying or depositing | Freeze blocks every creation path in the API with the customer row read `FOR SHARE` in the same transaction; reservations cancelled; Telegram approval blocked for frozen customers |
| A purchase racing a freeze or an archive | Freeze and archive lock the customer row `FOR UPDATE`; purchases read it `FOR SHARE` before writing; one commits first |
| Stolen funds pushed through many new accounts | Shared phone and shared IP signals on the profile and the deposit page; per-customer limit overrides; S03 flags unchanged |
| A stolen admin session raising limits or unfreezing a fraudster | Re-authentication and a reason on every state and limit change; audit with before and after |
| Archiving to hide money or open orders | Archive refused unless the balance is zero and nothing is open; the ledger and audit stay; unarchive possible |
| Ticket spam or support flooding | 3 open tickets, 5 a day, 20 messages an hour, one open ticket per order or deposit, Telegram grouped per ticket per 10 minutes |
| Malicious images (bombs, polyglots, EXIF location) | Type and size checks, sharp with a pixel limit, re-encoded WebP with metadata stripped, random storage keys, served `no-store` and `nosniff` only to the owner and the admin |
| Reading another customer's ticket or attachment | Every customer query filters by the session's customer; attachments served only through their ticket; `NOT_FOUND` otherwise; tests per route |
| Phishing through ticket text (links, fake "admin" messages) | Plain text only, no HTML, customer URLs not clickable in the panel; admin messages visually distinct with the store's name; customers cannot post as admin (author set by the route) |
| Replayed or double-submitted messages | `Idempotency-Key` unique per ticket and author |
| A customer linking someone else's order to read its details | The link must be the customer's own (`TICKET_LINK_INVALID`); the ticket shows only what the customer's own order page shows |
| Leaking ticket content through Telegram or email | Telegram carries the number, type, subject and email only; email carries the number and a link; never the body or images |
| Spoofed support link (a stolen session sets a fake Telegram account) | Re-authentication and audit on the setting; only `https://t.me/<name>` accepted |
| Personal data kept too long | Sign-in log deleted after 90 days |

## Edge cases
1. Freeze while the customer's checkout is mid-transaction: the checkout holds the customer row `FOR SHARE`; the freeze waits and then cancels nothing new (the checkout's orders are paid, not reservations) and the orders continue.
2. Freeze a customer with two reservations: both cancelled with reason `frozen`, the customer gets two `order_cancelled` notifications; nothing returns after unfreeze.
3. A frozen customer uploads a receipt for a deposit created before the freeze: accepted; the admin sees "العميل مجمّد" on the deposit and approves or rejects in the panel; Telegram Approve is absent.
4. A USDT transfer arrives for a frozen customer: credited (S04); no reservation is paid (they were cancelled).
5. A cap of $20 and a checkout of $25: refused as a whole with what remains; the cart stays.
6. A cap set while the customer already spent more today: the next purchase is refused until the 24-hour window frees room; refunds within the window free room by their refunded amount.
7. A reservation that alone is above the cap: refused at creation. One that fits alone but not with today's purchases: skipped by the payment until it fits or expires (24 hours, S09).
8. Lowering a deposit override below a deposit already `pending` or `submitted`: that deposit keeps its own amount (S03 checks at creation only); new deposits follow the new limit.
9. Archive with a balance of $0.004 (a USDT tail credited): refused with `balance`; the admin decides (an adjustment with the customer's consent, or leave it).
10. Archive with an open ticket: closed by the system; the customer cannot read it after archive.
11. Two admin tabs freeze the same customer: the second gets `CUSTOMER_STATE_INVALID`.
12. A customer opens a ticket for an order that has one closed 3 days ago: allowed (only non-closed tickets block); the panel shows both under the order.
13. A customer replies to a ticket closed 3 days ago while the same order has another open ticket: `TICKET_ALREADY_OPEN` with the open one's id.
14. The admin replies to a closed ticket when the customer already has 3 open ones: allowed (admin replies never count against the customer).
15. Auto-close runs while the customer is typing: the message reopens the ticket (within 7 days).
16. An image upload fails mid-request: the whole message is refused (one transaction); files written before the failure stay unreferenced and are never served.
17. Telegram not linked: `ticket_opened` and `ticket_reply` are skipped (S05); the badge and the dashboard still show the queue.
18. The admin sends three replies in a minute: three notifications in the center, one email.
19. Email preference off: center and SSE only.
20. A test customer's tickets: normal; the daily summary counts them (the admin acts on them), the dashboard's money ignores test customers as before.
21. Search for a phone without the country code ("0944…"): normalized to `+963944…` and matched exactly; a partial number of at least 6 digits matches as a suffix.
22. An order number that does not exist: an empty result, not an error.
23. Someone tries to sign up with an archived customer's email: refused as taken (S01); the email stays reserved while archived, so unarchiving never collides.
24. A customer signs in from 40 IPs in a month: the shared-IP signal lists at most 10 other customers; the devices tab pages the log.

## Open questions
None. Answered by the owner on 2026-10-10 (ADR 0026; Q14 resolved).

## Acceptance
The owner's browser check (local, `pnpm dev`, `SUPPLIER_FAKE_ENABLED=true`, `TELEGRAM_TRANSPORT=log`, the S08 data: "60 UC" on `fake-uc-60`; two real customers A and B sharing a phone, A funded by a manual-deposit adjustment):
1. `/customers`: search A by email, by phone without `+963`, and by one of A's order numbers; each finds A. The list shows balances and chips.
2. A's profile: the summary shows A as established or new, the limits with "الافتراضي", the shared-phone signal listing B. Sign in as B from the same browser profile: A's shared-IP signal lists B after a refresh.
3. Add a pinned note to A; open one of A's deposits and orders in the panel: the note and chips appear.
4. As A, create a reservation (balance short). Freeze A with a reason: the reservation is cancelled with a notification; the store shows the banner; buying, the cart, a deposit and a player check are refused with the sentence. A's open order page and code reveal still work. A Telegram card for a receipt A uploads to an earlier pending deposit shows no Approve. Unfreeze: buying works.
5. Set A's daily purchase cap to $1 and buy "60 UC" twice: the second is refused with what remains. Set A's per-deposit override to $500: the deposit wizard shows $500. Clear both: defaults return.
6. As A, open a ticket of type "طلب" from an order page with two images: the Telegram log shows `ticket_opened` without the body; the panel badge shows 1; the dashboard lists "تذاكر بانتظار ردّك". Reply from the panel with an image: A gets the notification and one email; the thread refreshes live. A replies twice quickly: one `ticket_reply` Telegram message.
7. Try a second ticket on the same order: refused with a link to the open one. Open 3 tickets, then a 4th: refused.
8. Close the ticket as A, reply 1 minute later: reopened. Set an answered ticket's last admin message 8 days back in the database and run the auto-close: closed by the system.
9. From A's profile, open a ticket to A about a deposit: A sees it as answered with a notification.
10. Archive A with a balance: refused with "balance". Zero the balance by an adjustment, archive: A is signed out and cannot sign in; open tickets closed. Unarchive: A signs in.
11. Set the Telegram support link: the store footer and `/support` show it; clear it: hidden.

Tests:
- Contracts (100%): `customerStatus`, `effectiveDepositLimitSettings` (each override, none, tiers), `purchaseCapBreach` at the boundary, `ticketTransition` for every state and event, `customerCanReply` at 7 days, the subject, body and limits schemas, the search classifier of CS1 (each kind and the phone normalization).
- Database (real PostgreSQL): the checks and partial unique indexes (one pinned note, one open ticket per order and per deposit, category ⇔ link), the append-only triggers (messages, attachments, note body), the freeze and archive locks against a concurrent order and checkout, the cap computation with refunds and the 24-hour edge, the reservation skip under the cap, the archive blockers.
- Concurrency and idempotency: freeze against a purchase (both orders), two freezes, the same message key replayed and reused with another body, two tickets for one order at once (one wins with `TICKET_ALREADY_OPEN`).
- API, every route: success, 401, a customer session on admin routes and an admin session on customer routes (403), another customer's ticket and attachment (404), re-authentication, every error code, `no-store`; every purchase and deposit route refusing a frozen customer; the Telegram approval refusal; the profile's signals; the history's entities.
- Worker: auto-close (only answered past 7 days, idempotent), the sign-in purge, the Telegram grouping per 10 minutes, the daily summary lines.
- E2E with RTL screenshots (light and dark for the panel, phone width for the store): `/customers`, the profile tabs and dialogs (freeze, limits, archive refused), the admin queue and thread with images, `/settings/support`; the store's frozen banner and disabled buy box, `/support`, `/support/new` with images, the thread (open and closed beyond 7 days).

## Implementation notes
- Suggested split (owner prefers fewer PRs), each leaving `main` green:
  1. Contracts, db (migration: `customers.frozen_at`, `customer_sign_ins`, `customer_limits`, `customer_notes`, the ticket tables and enums, `support_settings`, the file kind, the cancel reason `frozen`), the freeze and cap checks in every purchase and deposit write path, the Telegram approval refusal, the API (`customers` and `support` modules), the worker jobs and Telegram templates, the email template, OpenAPI and the admin client.
  2. Admin screens (customers, profile, support queue and thread, settings, the customer panels on deposit and order pages) and store screens (banner, disabled states, support pages, order and deposit help buttons, footer, preference); E2E and screenshots.
- The freeze check belongs in `packages/db` next to the purchase write paths (`orders/purchase.ts`, `orders/reservations.ts`, the checkout) and in the deposit creation paths, as one helper that reads the customer `FOR SHARE` and throws `ACCOUNT_FROZEN`; the cap check sits in the same helper so every path gets both.
- Update `docs/architecture.md` (the `customers` and `support` modules), `docs/open-questions.md` (Q14), the S05 daily summary and deposit card notes, and the commands table only if a new script is added.
