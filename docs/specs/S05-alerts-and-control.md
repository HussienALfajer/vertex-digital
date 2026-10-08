# S05 — Alerts and control (F07, F26, F27)

Status: Draft · Date: 2026-10-08 · Scope: `docs/product/v1-scope.md` §F07, §F26, §F27 (A09, A16, A17; A10 and A13 hooks) · ADRs: 0002, 0003, 0004, 0006, 0008, 0011, 0014, 0016, 0017, 0018, 0019

## Summary
The owner runs the store alone and needs three things before any real money arrives: a way to stop the store at once (F26), deposit cards and alerts on the phone so a Sham Cash receipt is not left waiting (F07), and customers who learn what happened to their money without asking (F27). S05 adds the store switches with their history (registration closed by default, emergency stop, a pause per deposit method), a Telegram admin bot linked to the admin account (deposit cards with Approve / Reject, the review reminder, alerts, a daily summary, an emergency stop button), and the customer notification center with live updates over SSE and per-event email preferences.

## In scope / out of scope
- In:
  - Store switches (F26): registration open/closed (replaces `REGISTRATION_OPEN`), emergency stop for purchases and for deposits, a pause for each deposit method (Sham Cash, USDT TRC20, USDT BEP20); re-authentication and audit for every change in the panel; history; banners in the store and the panel; the Telegram notice for every change (A17).
  - Telegram admin bot (F07): linking by a one-time deep link; the Sham Cash deposit card with Approve (up to the Telegram limit, unflagged only) and Reject (A09, ADR 0006); the USDT review card and the unmatched-transfer alert (information, Reject only); the review reminder (A09); the existing worker alert channel moved to the linked chat (A13); the daily summary at 22:30 `Asia/Damascus`; `/stop` (emergency stop, on only) and `/status`.
  - Customer notifications (F27): the notification center (bell with unread count, live over SSE, `/notifications` page) for deposit credited, deposit rejected, clearer receipt requested and wallet adjusted (A16, S02, S03, S04); per-event email preferences on `/account`; live refresh of the wallet and deposit pages on a notification.
- Out (later or never):
  - The per-supplier switch: S07 (F09), when suppliers exist. The switches table takes it as a new value then.
  - Reading the purchase stop in the pay transaction and holding A02 while purchases are stopped: S08 (F11). S05 stores and shows the switch.
  - Order, ticket and `awaiting_balance` notification events: S08, S09, S12 add theirs through the same write path.
  - Supplier alerts (A07, A08): S07 sends them through the alert channel.
  - Web push: S15 (F24). Telegram for customers: Phase 4.
  - Security events (new sign-in, password change) in the notification center: they stay emails only and cannot be turned off (S01).
  - Approving USDT reviews or flagged Sham Cash deposits from Telegram: never (ADR 0006, 0019).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the store status (stops, registration) | Public | Anyone |
| Read own notifications, mark them read, open the stream; read and change own email preferences | Customer | Signed-in customer with a verified email |
| Read the switches and their history; read the Telegram link status | Admin | The admin |
| Change a switch; create a Telegram link code; unlink Telegram | Admin, re-authentication | The admin |
| Send a Telegram test message | Admin | The admin |
| Bot updates (link, approve, reject, `/stop`, `/status`) | Webhook, Telegram secret header | Telegram, for the linked chat and user only (TG4) |
| Cards, reminders, alerts, summary | Worker jobs | System |

Customers only reach their own notifications and preferences: every query filters by the session's customer.

## Data

### `store_switch_changes` (new; owner: `settings`; append-only)
One row per change. The current value of a switch is its newest row; a switch with no row has its default.
- `id` uuid v7; `switch` enum `store_switch`; `value` boolean; `admin_id` uuid (no foreign key, as `deposit_settings`); `channel` enum (`admin`, `telegram`); `created_at`.
- `store_switch` values and defaults (`STORE_SWITCHES` in `packages/contracts`):
  - `registration_open` (false: closed);
  - `purchases_stopped` (false), `deposits_stopped` (false): the emergency stop;
  - `sham_cash_paused`, `usdt_trc20_paused`, `usdt_bep20_paused` (false).
- Index `(switch, created_at desc)`. Append-only trigger and grants (`APPEND_ONLY_TABLES`).

### `customer_notifications` (new; owner: `notifications`)
A delivery record, not a business record: never archived, never deleted in V1.
- `id` uuid v7; `customer_id` uuid FK `customers`; `event` enum `notification_event`; `params` jsonb (validated by `NOTIFICATION_PARAMS`, NT3); `read_at` timestamptz nullable; `created_at`.
- `notification_event` values (`NOTIFICATION_EVENTS`): `deposit_credited`, `deposit_rejected`, `deposit_receipt_requested`, `wallet_adjusted`. Later specs append theirs.
- Indexes: `(customer_id, created_at desc, id desc)` for the list; partial `(customer_id) where read_at is null` for the count.
- The app role may update `read_at` only (column grant); a trigger refuses any other update.

### `notification_preferences` (new; owner: `notifications`)
- `customer_id` uuid FK; `event` enum `notification_event`; `email` boolean; `updated_at`. Primary key `(customer_id, event)`.
- A missing row means email on (owner, 2026-10-08: every event email is optional and on by default).

### `telegram_links` (new; owner: `telegram`)
- `id` uuid v7; `admin_id` uuid FK `admin_users`; `chat_id` bigint; `telegram_user_id` bigint; `telegram_username` text nullable (shown in the panel only); `linked_at`; `unlinked_at` nullable.
- Partial unique index on `(admin_id) where unlinked_at is null`: one live link. Rows are kept after unlinking (history).

### `telegram_link_codes` (new; owner: `telegram`)
- `id` uuid v7; `admin_id` uuid FK; `code_sha256` bytea unique; `expires_at` (10 minutes); `used_at` nullable; `created_at`.
- The code itself (22 base64url characters, 128 random bits) is returned once and never stored.

### `telegram_messages` (new; owner: `telegram`; the bot's outbox)
- `id` uuid v7; `kind` enum `telegram_message_kind`; `params` jsonb (validated by `TELEGRAM_MESSAGE_PARAMS`); `dedupe_key` text unique nullable; `status` (`pending`, `sent`, `failed`, `skipped`); `attempts` int; `last_error` text (class and message, never the token or the body); `telegram_message_id` bigint nullable; `sent_at`; `created_at`.
- `telegram_message_kind` values: `switch_changed`, `usdt_unmatched`, `review_reminder`, `daily_summary`, `bot_reply`, `link_changed`, `test`.
- `dedupe_key` examples: `switch:<changeId>`, `unmatched:<transferId>`, `summary:2026-10-08`. A second insert with the same key is ignored.
- The chat is not stored per message: the worker sends to the live link at send time; with no link the row becomes `skipped`.

### `telegram_deposit_cards` (new; owner: `telegram`)
- `deposit_id` uuid FK; `submitted_at` timestamptz (the deposit's submission this card shows; a clearer-receipt round gives a new card); `chat_id` bigint; `message_id` bigint; `reminded_at` timestamptz nullable; `updated_at`. Primary key `(deposit_id, submitted_at)`.

### `telegram_prompts` (new; owner: `telegram`)
The bot's open question, one at a time (TG7).
- `id` uuid v7; `kind` (`approve_number`, `approve_confirm`, `reject_note`, `stop_confirm`); `deposit_id` uuid nullable; `deposit_submitted_at` timestamptz nullable; `data` jsonb (`transactionNumber`, `reason`, `scope`); `expires_at` (10 minutes); `closed_at` nullable; `created_at`.
- Partial unique index on `((true)) where closed_at is null`: at most one open prompt.

### `telegram_updates` (new; owner: `telegram`)
- `update_id` bigint primary key; `received_at`. Makes webhook redeliveries no-ops (TG5). Rows older than 7 days are deleted by the reminder job.

### `telegram_bot_state` (new; owner: `telegram`; one row)
- `id` smallint primary key check `= 1`; `last_reminder_at` timestamptz nullable.

### `deposit_settings` (exists; new column)
- `telegram_approval_max_usd_units` bigint, default $100, check `between 0 and 100_000_000` and whole cents. 0 turns Telegram approval off. It cannot exceed $100, the re-authentication threshold of S03 rule RV4 (ADR 0019).

### Contracts
- `STORE_SWITCHES`, `storeSwitchSchema`, `STORE_SWITCH_DEFAULTS`, `storeStatusSchema`, `adminSwitchesSchema`, `changeSwitchSchema` (`{ switch, value }`), `switchChangeSchema` (history row).
- `NOTIFICATION_EVENTS`, `NOTIFICATION_PARAMS` (the same minimal fields as the matching email params: amounts, reference code, reason code, adjustment direction and category; never notes, transaction numbers, TXIDs or flags), `customerNotificationSchema`, `notificationPageSchema` (`items`, `nextCursor`, `unreadCount`), `notificationPreferencesSchema`, `NOTIFICATION_EMAIL_TEMPLATE` (event → email template).
- `TELEGRAM_MESSAGE_KINDS`, `TELEGRAM_MESSAGE_PARAMS`, `telegramLinkStatusSchema`, `telegramLinkCodeSchema` (`deepLink`, `expiresAt`), `TELEGRAM_CALLBACKS` (TG6).
- Error codes: `DEPOSITS_STOPPED` (`details.reason`: `emergency` or `method_paused`), `TELEGRAM_NOT_CONFIGURED`.
- Audit: actions in "Audit and notifications"; entity type `store_switch`.
- Queues: `telegram.send`, `telegram.deposit-card` (`stately` per deposit), `telegram.review-reminder`, `telegram.daily-summary`.

## States and rules

### Store switches (F26)
- SW1. Each switch is a boolean whose current value is its newest `store_switch_changes` row, or its default. The API reads them per request; there is no cache, so a change is effective at the next request in the store, the API and the worker (A17).
- SW2. A change takes `{ switch, value }`. It runs in one transaction: take the switches lock (`pg_advisory_xact_lock` on the `settings` key), read the current value, insert the row, write the audit entry, insert the `switch_changed` Telegram message. A change to the current value returns the state with no row, no audit and no message.
- SW3. Panel changes require re-authentication (F02, S01 rule D5), in both directions. Telegram can only turn `purchases_stopped` and `deposits_stopped` **on**, after a confirm button and without re-authentication (owner, 2026-10-08). Every other change is panel-only.
- SW4. **Deposit stop** (`deposits_stopped`, or the method's `*_paused`) refuses only the **creation** of a deposit of that method, with `DEPOSITS_STOPPED` (owner, 2026-10-08). Everything about deposits that already exist goes on: requote, receipt submission, TXID submission, cancellation, the USDT scan and verification and their automatic credits, expiry, and the admin's review. Money a customer already sent never waits on a switch.
- SW5. Deposit creation (Sham Cash and USDT) takes the switches lock in shared mode (`pg_advisory_xact_lock_shared`) and reads the switches inside its transaction. A creation therefore either commits before a stop or sees it.
- SW6. The deposit options routes report each method as `available`, `paused` (its switch), `stopped` (the emergency stop) or `unavailable` (not configured, S03 SC1 and S04). The store shows paused and stopped methods disabled with the stop text, not hidden.
- SW7. **Purchase stop** (`purchases_stopped`) is stored, shown and announced now. S08 reads it in the pay transaction with the same shared lock, refuses new purchases with a coded error, and holds A02's automatic payment of `awaiting_balance` orders while it is on. Paid orders keep being fulfilled or refunded (F26, ADR 0004).
- SW8. **Registration** (`registration_open`) replaces the `REGISTRATION_OPEN` variable of S01 rule C16, which is removed from the API's environment and `.env.example`. Sign-up and `GET /api/auth/registration` read the switch. Test customers (S01 rules T1–T4) are created while it is closed. Every production deploy before the pilot leaves it closed: no migration or seed ever inserts `registration_open = true`. Local development opens it once in the panel; API tests and E2E set it through their fixtures.
- SW9. The store's banner: while `purchases_stopped` or `deposits_stopped` is on, every page shows a calm fixed notice under the header (owner, 2026-10-08: fixed text, no admin message): "نجري صيانة قصيرة. الإيداع متوقف مؤقتاً، ورصيدك وطلباتك بأمان." (the wording names what is stopped: الإيداع، الشراء، or both). Method pauses show only on the deposit screens.
- SW10. The panel's banner: while any emergency stop or method pause is on, every panel page shows a banner naming the active switches and since when, linking to `/settings/switches`. Closed registration is the pre-pilot normal and gets no banner; it is shown on the switches page and in the daily summary.

### Customer notifications (F27)
- NT1. Every customer event of `NOTIFICATION_EVENTS` writes one `customer_notifications` row, in the transaction of the change, through `notifyCustomer(tx, boss, { customerId, event, params })` in `packages/db/src/notifications`, used by the API and the worker. The call also:
  - queues the matching email (outbox row and `email.send` job, S01 rule E1) unless the customer's preference for the event is off;
  - runs `pg_notify('customer_notifications', <notification id>)`, delivered at commit.
- NT2. The existing email call sites move to `notifyCustomer`: deposit credited (S03 approval, S04 automatic and reviewed credits), deposit rejected (S03, S04), clearer receipt requested (S03 RV8), wallet adjusted and its reversal (S02). Nothing else changes in those transactions.
- NT3. Params carry what the customer needs and nothing more (F27): the reference code and USD credit for a credit; the reason code for a rejection (never the admin's notes); the reference code for a receipt request; the direction, amount, category and reversal flag for an adjustment. The text is rendered in the store through i18n.
- NT4. Each notification links to its page: deposit events to `/wallet/deposits/<id>`, adjustments to `/wallet`.
- NT5. Reading: the list is newest first, cursor-paged (20). Opening `/notifications` marks everything up to the newest shown notification as read (`POST /api/notifications/read` with `upToId`); notifications shown unread keep their highlight for that visit. The unread count is computed per request from the partial index.
- NT6. **Live stream** `GET /api/notifications/stream` (SSE, customer session):
  - on connect, an `unread` event with the count;
  - on each new notification of this customer, a `notification` event with the notification and the new count;
  - a comment line every 25 seconds keeps proxies open;
  - the API holds one `LISTEN customer_notifications` connection and fans events out to the open streams by customer. When that connection drops and comes back, each stream receives a `resync` event and the client refetches the count;
  - at most 3 open streams per customer (a 4th closes the oldest); connections are rate-limited to 30 per minute per customer; the session is checked at connect and every 5 minutes, and the stream closes when it is no longer valid.
- NT7. The store reconnects with `EventSource`'s own retry. On a `notification` for a deposit, an open `/wallet/deposits/<id>` page and `/wallet` refetch their data; on any money event `/wallet` refetches the balance (S02's live balance).
- NT8. **Email preferences** (owner, 2026-10-08): one switch per event, all on by default, all optional. Changing one writes or updates its row and an audit entry. A preference applies to emails queued after the change. Security emails (S01: codes, password and email changes, new sign-in, sign-up attempt) are listed as always on and cannot be changed. The notification center records every event regardless of the email preference.

### Telegram admin bot (F07)
- TG1. **Setup** (Q11, owner 2026-10-08): the owner creates the bot with BotFather. Its token lives in the worker's server environment only (`TELEGRAM_BOT_TOKEN`); the API holds `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_USERNAME` (for the deep link); the worker holds the secret too, and `TELEGRAM_WEBHOOK_URL`. Everything goes to the admin's private chat with the bot: cards, alerts, reminders and the summary. `TELEGRAM_ALERTS_CHAT_ID` is removed.
- TG2. **Updates by webhook to the API** (ADR 0019): at start the worker calls `setWebhook(url, secret_token, allowed_updates: [message, callback_query])` when the bot is configured (idempotent). Telegram posts updates to `POST /api/webhooks/telegram`. The API runs every bot action through the same services as the panel (ADR 0006: one service path, the channel recorded). The API never calls Telegram: it answers a callback inline in the webhook response (`answerCallbackQuery`) and queues every other reply as a `telegram_messages` row, sent by the worker.
- TG3. **Linking**: in the panel, "ربط تيليجرام" (re-authentication) creates a link code and shows the deep link `https://t.me/<bot>?start=<code>` with a QR code and a 10-minute countdown. `/start <code>` in a **private** chat with an unused, unexpired code links that chat and Telegram user: any previous live link gets `unlinked_at`, a `link_changed` message goes to the old chat, and the new chat gets a welcome with `/status` and `/stop`. The panel polls the link status until linked. Unlinking (re-authentication) ends the live link. A code is single use; a wrong, used or expired code gets a generic "الرمز غير صالح" reply.
- TG4. **Who may act**: an update is acted on only when the webhook secret header matches (constant-time) and the sender's user id and chat id equal the live link. Anything else, except `/start <code>` in a private chat, is ignored with no reply.
- TG5. **Redeliveries**: the API inserts the `update_id` into `telegram_updates` first, in the transaction of the action; an existing id means the update was handled and the API answers 200 with nothing else. The webhook always answers 200 quickly, so Telegram does not retry real failures: an action that fails sends its error as a bot reply.
- TG6. **Callback data** (at most 64 bytes): `ap:<depositId>` (approve), `rj:<depositId>` (reject), `rr:<promptId>:<reason>` (reject reason), `ok:<promptId>` (confirm), `no:<promptId>` (cancel), `st:<scope>` (stop: `purchases`, `deposits`, `both`). Buttons on an old card hit the service's own state checks.
- TG7. **Prompts**: a question the bot asks (transaction number, rejection note, confirmation) is an open `telegram_prompts` row. Opening one closes any other. The admin's next plain text message answers the open prompt; with none open, or past its 10 minutes, the bot replies with the help text.

### Deposit cards and decisions from Telegram (A09, A10)
- TC1. Cards are sent for: a Sham Cash deposit that reaches `submitted` (each submission, including after a clearer-receipt request), and a USDT deposit that reaches `review` (S04 rule U11). The submitting transaction queues `telegram.deposit-card` with the deposit id.
- TC2. **Sham Cash card**: the receipt image (re-encoded to JPEG for Telegram) with a caption: reference code, declared amount and currency with its USD value and rate, the customer's name, "حساب جديد" or the number of credited deposits, the flags in Arabic words, the time submitted, and a link to `/deposits/<id>` in the panel. Buttons:
  - "اعتماد $X" when TC4 allows approval from Telegram; otherwise a line saying why ("عليه علامات"، "فوق حد تيليجرام") and only the panel link;
  - "رفض".
- TC3. **USDT review card** (owner, 2026-10-08: information): network, received and expected amounts, the review reason in words, the TXID shortened with an explorer link, and the panel link. One button: "رفض". Approving a USDT review is panel-only: it always carries a flag and needs re-authentication (S04).
- TC4. **Approval from Telegram** (owner, 2026-10-08; ADR 0006) is allowed only for a Sham Cash deposit that is `submitted`, has **no flag**, and whose credit at the declared amount is at most `telegram_approval_max_usd_units` ($100 by default; 0 turns it off). Flow:
  1. "اعتماد" opens an `approve_number` prompt: "أرسل رقم عملية شام كاش لـ VD-XXXX. تأكد من وصول التحويل في حساب شام كاش نفسه، لا من الصورة." (S03 RV1).
  2. The admin replies with the number (1–64 characters, normalized as S03). The bot opens an `approve_confirm` prompt: "اعتماد VD-XXXX: إضافة $X برقم العملية Y؟" with "تأكيد" and "إلغاء".
  3. "تأكيد" calls the S03 approval service with: the transaction number, received currency and amount equal to the declared ones, reference check `matches`, no acknowledged flags, no internal note, `Idempotency-Key` `telegram:<promptId>`, actor the admin, channel `telegram`. The service re-checks everything at that moment (state, no flags, the limit, the submission time of the prompt). A different amount, a missing or different reference, or any flag is a panel decision.
  4. The result is a bot reply (credited, or the refusal: `EXTERNAL_REFERENCE_TAKEN` "رقم العملية مستخدم سابقاً، راجع من اللوحة", `DEPOSIT_STATE_CONFLICT` "تم البت فيه مسبقاً"), and the card is updated.
- TC5. **Rejection from Telegram** (owner, 2026-10-08), for Sham Cash deposits and USDT reviews, flagged or not (it moves no money): "رفض" shows the reason buttons (S03 RV6 without `other`; USDT adds `wrong_network` and `transfer_other_customer`), then a `reject_note` prompt asks for the internal note (5–500 characters). The note runs the S03/S04 reject service with no customer note, `Idempotency-Key` `telegram:<promptId>`, channel `telegram`. `other`, a customer note and "request a clearer receipt" are panel-only.
- TC6. **Card updates**: every decision, expiry, cancellation or clearer-receipt request of a deposit with a card queues `telegram.deposit-card`; the job edits the card's caption to the outcome ("✅ أُضيف $X (من اللوحة)"، "❌ رُفض: السبب"، "↩️ طُلب إيصال أوضح") and removes its buttons.
- TC7. **Unmatched USDT transfers** (S04 rule U13): each new unmatched transfer queues one `usdt_unmatched` message (`dedupe_key` `unmatched:<transferId>`): network, amount, sender shortened, the number of candidate deposits, the panel link to `/deposits/transfers`. No buttons.

### Review reminder (A09)
- RM1. `telegram.review-reminder` runs every 5 minutes. It acts only within the review hours of the deposit settings (S03: 10:00–22:00 `Asia/Damascus`).
- RM2. A deposit **waits** when it is a Sham Cash `submitted` deposit or a USDT deposit in `review`. Its wait is counted from its submission, or from today's opening when it was submitted outside hours. It is **overdue** past `review_target_minutes` (15).
- RM3. A reminder is sent when an overdue deposit has no `reminded_at` yet, or when overdue deposits remain and the last reminder is 30 minutes old or more (owner, 2026-10-08). It is one grouped message: the count, the oldest wait, and each deposit's reference code and wait (at most 10 lines, then "و N غيرها"), with the panel link. The job then sets `reminded_at` on the listed cards and `last_reminder_at`.
- RM4. So a deposit submitted at 23:00 is reminded at 10:15 the next morning, and every 30 minutes after that while it waits.

### Alerts and daily summary
- AL1. The worker's alert channel (`TelegramAlerts`, A13) keeps its rate limit and de-duplication and sends to the live link's chat, read from the database and cached for 60 seconds. With no link it logs and drops.
- AL2. **Switch notices** (A17): every switch change sends `switch_changed`: "⛔ أُوقفت الإيداعات (من اللوحة)"، "✅ أُعيد فتح الشراء"، "التسجيل مفتوح الآن", with the channel.
- AL3. **Daily summary** at 22:30 `Asia/Damascus` (owner, 2026-10-08), `dedupe_key` `summary:<date>`, covering the Damascus calendar day so far:
  - deposits credited per method (count and USD), how many were approved from Telegram, rejected, expired;
  - deposits waiting now (count and oldest wait); unmatched USDT transfers of the day and still open (30 days);
  - new customers; the total of real customers' wallets (S02 ledger summary, rule L1);
  - the switches: registration open or closed, and every active stop or pause with since when;
  - the alerts suppressed by the rate limit that day, if any.
- AL4. Bot commands: `/status` replies with the switches, the waiting count and the unmatched count; `/stop` shows the three stop buttons (TG6) then a confirm prompt; a stop already on answers "متوقف مسبقاً"; the reply always says that reopening is done from the panel. `/help` lists them. Any other text with no open prompt gets the help.

## Money flows
None new. An approval from Telegram posts exactly the S03 Sham Cash credit journal (S03 Money flows, rule RV7), through the same service, with the same idempotency (`decision_idempotency_key` = `telegram:<promptId>`). Rejections, switches, notifications and messages move no money. A deposit or purchase stop never touches existing money (SW4, SW7).

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/store/status` | Public, `Cache-Control: public, max-age=10` | — | `storeStatusSchema` (`registrationOpen`, `purchasesStopped`, `depositsStopped`) | — |
| `GET /api/auth/registration` | Public (exists) | — | `{ open }` from the switch | — |
| `GET /api/deposits/sham-cash/options`, `GET /api/deposits/usdt/options` | Customer (exist) | — | each method gains `state` (SW6) | — |
| `POST /api/deposits/sham-cash`, `POST /api/deposits/usdt` | Customer (exist) | as S03/S04 | as S03/S04 | adds `DEPOSITS_STOPPED` |
| `GET /api/notifications` | Customer | cursor | `notificationPageSchema` | `VALIDATION_FAILED` |
| `POST /api/notifications/read` | Customer | `{ upToId }` | `{ unreadCount }` | `NOT_FOUND` (not the customer's) |
| `GET /api/notifications/stream` | Customer, SSE | — | `text/event-stream` (NT6) | `RATE_LIMITED` |
| `GET /api/account/notification-preferences` | Customer | — | `notificationPreferencesSchema` | — |
| `PUT /api/account/notification-preferences` | Customer | `{ event, email }` | `notificationPreferencesSchema` | `VALIDATION_FAILED` |
| `GET /api/admin/switches` | Admin | — | `adminSwitchesSchema` (each switch: value, default, since, channel) | — |
| `POST /api/admin/switches` | Admin, re-authentication | `changeSwitchSchema` | `adminSwitchesSchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED` |
| `GET /api/admin/switches/history` | Admin | `switch?`, cursor | page of `switchChangeSchema`, newest first | `VALIDATION_FAILED` |
| `GET /api/admin/telegram` | Admin | — | `telegramLinkStatusSchema` (configured, linked, username, since, last message status) | — |
| `POST /api/admin/telegram/link-code` | Admin, re-authentication | — | `201` `telegramLinkCodeSchema` | `REAUTHENTICATION_REQUIRED`, `TELEGRAM_NOT_CONFIGURED` |
| `DELETE /api/admin/telegram/link` | Admin, re-authentication | — | `telegramLinkStatusSchema` | `REAUTHENTICATION_REQUIRED` |
| `POST /api/admin/telegram/test` | Admin | — | `202` | `TELEGRAM_NOT_CONFIGURED`, `NOT_FOUND` (no link) |
| `PUT /api/admin/deposit-settings` | Admin, re-authentication (exists) | adds `telegramApprovalMaxUsdUnits` | as S03 | as S03 |
| `POST /api/webhooks/telegram` | Webhook: `X-Telegram-Bot-Api-Secret-Token` | Telegram `Update` (parsed with a strict subset schema, 64 KB limit) | `200`, empty or an inline `answerCallbackQuery` | `401` without the secret (no body) |

Notification and preference responses are `Cache-Control: no-store`.

## Jobs and integrations
- `telegram.send` (`{ messageId }`): renders the `telegram_messages` row (Arabic text, no personal data beyond what the kind needs), sends it to the live link, records `telegram_message_id`, `sent_at` or the error. Retries 5 times with backoff; a `429` waits its `retry_after`; a `403` (bot blocked by the admin) fails without retry and raises a log warning. A row not `pending` is skipped, so a second run is a no-op.
- `telegram.deposit-card` (`{ depositId }`, `stately` per deposit): loads the deposit fresh and sends or edits its card (TC1–TC6). Safe twice: it edits the existing `(deposit_id, submitted_at)` card instead of sending another.
- `telegram.review-reminder`: cron every 5 minutes (RM1–RM4); also deletes `telegram_updates` older than 7 days and closes expired prompts.
- `telegram.daily-summary`: cron `30 22 * * *` in `Asia/Damascus`; idempotent through its `dedupe_key`.
- Worker start: `setWebhook` (TG2) when `TELEGRAM_BOT_TOKEN` is set; failure logs and retries at the next start, alerts stay queued.
- Local development and tests (`TELEGRAM_TRANSPORT=log`): the worker writes each message, with its buttons, as a JSON file under `.data/telegram/` instead of calling Telegram, as the email `log` transport does. A CLI posts updates to the local webhook with the secret: `pnpm --filter @vertex-digital/api telegram:fake-update --start <code> | --text <text> | --tap <button text>` (`--tap` presses that button on the newest message file). The commands table in `AGENTS.md` gains it.
- nginx (store host): `/api/webhooks/telegram` is accepted only from Telegram's published webhook ranges (checked against `core.telegram.org/bots/webhooks` when implemented; 149.154.160.0/20 and 91.108.4.0/22 at the time of writing), with a 64 KB body limit. `/api/notifications/stream` has buffering off and a long read timeout.
- Emails: unchanged templates; NT1 decides whether each is queued.

## Screens

### Store (Arabic, RTL, phone width first; dynamic, never cached)
- **Header bell** (signed in): the bell icon with an unread badge (hidden at 0, "9+" above 9), live from the stream; it links to `/notifications`. Signed out: no bell.
- **`/notifications`**: the list (icon per event, the Arabic sentence, relative time with the full date on long press or hover, unread highlight), "عرض المزيد" for the next page. Tapping an item opens its page (NT4). Empty: "لا توجد إشعارات بعد. سنخبرك هنا عند إضافة رصيدك أو أي تغيير عليه." Loading: skeleton rows. Error: a retry button.
- **`/account` → الإشعارات**: a switch per event with its one-line description ("عند إضافة إيداع إلى رصيدك"، "عند رفض إيداع"، "عند طلب إيصال أوضح"، "عند تعديل رصيدك من الإدارة"), saved on toggle with a toast. A greyed "رسائل الأمان (رموز التحقق، تغيير كلمة المرور، تسجيل دخول جديد)" row marked always on, and a line that the notification center always shows everything.
- **Stop banner** (SW9) under the header on every page, in the warning tone of `brand/identity.md`, not dismissible.
- **Deposit wizard and method choice**: a paused or stopped method shows disabled with "متوقف مؤقتاً"; when every method is unavailable the wizard shows the stop text instead of the form. A `DEPOSITS_STOPPED` answer (a race with a stop) shows the same text and keeps the form values.
- `/wallet` and `/wallet/deposits/<id>` refresh on their stream events (NT7).

### Admin (Arabic, RTL)
- **Global banner** (SW10).
- **`/settings/switches`** (new navigation entry "المفاتيح"):
  - Emergency stop: two large toggles "إيقاف الشراء" and "إيقاف الإيداع" with since when and from where (اللوحة، تيليجرام).
  - Deposit methods: "شام كاش"، "USDT TRC20"، "USDT BEP20" pause toggles, each with a note when the method is also unconfigured in the deposit settings.
  - Registration: "التسجيل مفتوح / مغلق", with a warning when opening ("أي شخص يستطيع إنشاء حساب وإيداع مال حقيقي").
  - Each toggle opens a confirm dialog naming the effect, then re-authentication.
  - History below: time, switch, from → to, channel, cursor-paged, filter by switch.
- **`/settings/telegram`** (new): not configured (env missing: explains the server variables); not linked ("ربط تيليجرام" → deep link, QR, countdown, then "تم الربط" when the status changes); linked (username, since, the last message's status, "إرسال رسالة اختبار", "إلغاء الربط" with re-authentication).
- **`/settings/deposits`**: a new field "حد الاعتماد من تيليجرام ($)" (0–100, 0 off) with its help text.
- **`/deposits/<id>`**: the audit trail shows "من تيليجرام" on decisions made there (the entry's channel).
- Loading, empty and error states follow the existing settings pages.

## Audit and notifications
Every entry in its transaction.
- `store_switch.changed` (admin, channel `admin` or `telegram`; entity `store_switch`, id the change row): `{ switch, before, after }`.
- `telegram.link_code_created` (admin): `{ expiresAt }` (never the code).
- `telegram.linked` (admin, channel `telegram`): `{ telegramUserId, previousLinkId }`. `telegram.unlinked` (admin): `{ linkId }`.
- `customer.notification_preference_changed` (customer, channel `store`): `{ event, email }`.
- `deposit_settings.changed` gains `telegramApprovalMaxUsdUnits`.
- Decisions from Telegram write the existing `deposit.credited` / `deposit.rejected` entries with channel `telegram`.
- Not audited: reading or marking notifications, the stream, messages sent, bot replies, `/status`.

Notifications:
- Customer: NT1–NT8 (A16 and the S02 adjustment).
- Admin (Telegram): cards (A09), the review reminder (A09), switch notices (A17), unmatched transfers, the worker alerts (A13), the daily summary.

## Abuse and fraud
| Threat | Control |
|---|---|
| Forged webhook calls (approve, stop) | Secret token header compared in constant time; nginx accepts only Telegram's ranges; the sender's user and chat must equal the live link (TG4) |
| Stolen or unlocked Telegram account | Approval only for unflagged Sham Cash deposits up to $100 each (limit editable, capped at $100, 0 off), always with a transaction number and a confirm step; new-account deposits of $25 or more and the 4th submission in 24 hours are flagged (S03 FL3, FL4), so they are panel-only; Telegram cannot reopen the store, change settings or approve USDT; every action audited with channel `telegram`, visible on the card, the deposit page and the daily summary; unlinking from the panel cuts it at once |
| Link hijack | 128-bit single-use code, 10 minutes, private chat only, created after re-authentication; a new link notifies the old chat; audit |
| Webhook redelivery or double tap | `telegram_updates` dedupe; approval and rejection carry `Idempotency-Key` `telegram:<promptId>` (S03 RV9); one open prompt |
| A stale button after a panel decision | The service re-checks state; the bot answers "تم البت فيه مسبقاً" |
| A deposit created during a stop (race) | Shared/exclusive advisory lock (SW5) |
| Bot token leak | Token in the worker environment only; the API never holds it; the breadcrumb scrubber (ADR 0008); errors log the class only |
| Stream exhaustion | 3 streams per customer, 30 connects a minute, session re-check, heartbeat; nginx connection limits |
| Notification spoofing or leakage | Rows written only by `notifyCustomer` in server transactions; customer-filtered reads; params hold no notes, flags, TXIDs or transaction numbers |
| Opening registration by mistake | Re-authentication, a confirm dialog with a warning, a Telegram notice, the daily summary line |

## Edge cases
1. Telegram is down or slow: messages stay `pending` and retry; decisions in the panel are never blocked; cards arrive late or are edited to their outcome directly.
2. The bot is not linked (or not configured): cards and messages are `skipped`, alerts are logged; the panel's Telegram page says so. Linking later does not replay skipped cards: the reminder lists every waiting deposit anyway.
3. The admin approves in the panel while a Telegram prompt is open: the confirm hits `DEPOSIT_STATE_CONFLICT`, the bot says it was decided, the card shows the outcome.
4. A clearer receipt is requested while a Telegram approval prompt is open, then resubmitted: the prompt's `deposit_submitted_at` no longer matches, so the confirm is refused ("تغيّر الإيداع، استخدم البطاقة الجديدة").
5. The admin lowers the Telegram limit below a card's amount: the confirm re-checks and refuses ("فوق حد تيليجرام، اعتمد من اللوحة").
6. The admin replies with text while no prompt is open, or after 10 minutes: help text; nothing happens.
7. Two webhook deliveries of one update arrive at once: the `update_id` primary key lets one through.
8. Emergency stop turned on while a customer is on the deposit form: creation answers `DEPOSITS_STOPPED`; the form keeps its values.
9. A USDT transfer arrives for a deposit created before the stop: credited automatically (SW4); its notification is sent.
10. A Sham Cash method paused while a customer has a `pending` deposit: they can still submit the receipt; the admin reviews it.
11. Both purchases and deposits stopped from Telegram: two rows, two audit entries, one combined notice per change (two messages).
12. Registration turned off while someone is mid sign-up: the code verification step still finishes accounts already created (S01); only new sign-ups are refused.
13. The stream's LISTEN connection is lost: streams get `resync` and refetch; notifications are never lost because the list is read from the table.
14. A customer has many tabs: the 4th stream closes the oldest; that tab's `EventSource` retries and closes another, so tabs compete but each shows the right count on focus (the store refetches the count on `visibilitychange`).
15. A notification for an archived customer: written anyway (it is a record of what happened); the email follows the existing outbox rules.
16. Preference turned off between the event and the email being sent: the email was queued with the event and is sent (NT8).
17. The daily summary job runs twice (worker restart): `dedupe_key` sends it once.
18. The worker restarts mid reminder: `reminded_at` and `last_reminder_at` are written in the same transaction as the message row, so the next run neither skips nor repeats.
19. The admin's Telegram blocks the bot: messages fail with 403; the panel's Telegram page shows the last error; the summary is lost for that day.
20. Clock and time zone: review hours, the reminder and the summary use `Asia/Damascus` from the database's `now()`; functions take `now` as an argument for tests.

## Open questions
None. Q11 (bot and chat) was answered on 2026-10-08: the owner creates the bot, everything goes to the admin's private chat (ADR 0019). The Telegram approval limit ($100, unflagged only), the emergency stop from Telegram (on only), the summary time (22:30), the reminder cadence (at the target, then every 30 minutes), the deposit stop's reach (creation only), the store notice (fixed text), the email preferences (all optional, on by default), rejection from Telegram (reason buttons) and the method pause (a separate switch) were settled the same day.

## Acceptance
The owner's browser check (local, `pnpm dev`, `TELEGRAM_TRANSPORT=log`, emails and Telegram messages written to files, a test customer from S01):
1. Panel `/settings/switches`: registration shows closed. Open it: the warning, then re-authentication. The store's sign-up link appears. Close it again. The history shows both rows.
2. Panel `/settings/telegram`: "ربط تيليجرام" (re-authentication) shows the link. Run `pnpm --filter @vertex-digital/api telegram:fake-update --start <code>`: the page turns to linked and a welcome message file appears. "إرسال رسالة اختبار" writes another file.
3. Store, as the test customer: create a $20 Sham Cash deposit and submit a receipt. A card file appears with the receipt, the caption and the buttons "اعتماد $20.00" and "رفض".
4. `telegram:fake-update --tap "اعتماد $20.00"`, then `--text TEST-101`, then `--tap "تأكيد"`: the deposit is credited; the card file is edited to "✅"; the store's bell shows 1 without a reload; `/notifications` lists "أُضيف $20.00 إلى رصيدك (VD-…)"; the wallet shows the balance; the email file exists; the panel's deposit page shows the decision "من تيليجرام".
5. A $60 deposit (or one flagged `new_account_large`): its card has no approve button and says why. Reject it from Telegram with "لم يصل التحويل" and a note: the store shows the rejection and the notification.
6. `/account` → الإشعارات: turn off "عند رفض إيداع". Reject another deposit: the notification appears, no new email file.
7. `telegram:fake-update --text /stop`, tap "الإيداعات", then "تأكيد": the store shows the maintenance banner and the deposit form is disabled; the panel shows the red banner; a notice file exists. Try `/stop` again: "متوقف مسبقاً". Reopen from the panel (re-authentication): the banner goes, a notice file exists.
8. Pause "USDT TRC20" in the panel: the store shows that network disabled, the other methods work.
9. Leave a submitted deposit for 15 minutes within 10:00–22:00 (or set the target to 1 minute): a reminder file appears; 30 minutes later another.
10. The audit log shows the switch changes, the Telegram link, the preference change and the decisions with channel `telegram`.

Tests:
- API, every route: success, 401, the customer/admin separation, a customer reading another's notifications (`NOT_FOUND`), every error code above, re-authentication on switch changes and Telegram link routes, `no-store` headers.
- Webhook: no secret or a wrong one → 401; an unknown sender ignored; `/start` with a wrong, used, expired code and from a group chat; a redelivered `update_id`; approve flow end to end; approve refused for flagged, over-limit, limit 0, changed submission, USDT; reject flow; `/stop` on, already on, never off.
- Money and concurrency (real PostgreSQL): a Telegram confirm racing a panel approval → one journal, one audit entry, one notification, one email; two confirms with the same prompt → one credit; a deposit creation racing an emergency stop → it either commits before the stop's row or is refused; two switch changes in parallel → serialized, history consistent.
- Notifications: `notifyCustomer` writes the row, honours the preference, and `pg_notify` fires only on commit (a rolled-back credit leaves no row, no email, no event); the stream delivers to the right customer only; the 4th stream closes the oldest; the session check closes a revoked stream.
- Database: the append-only trigger and grants on `store_switch_changes`; the `read_at`-only update grant on `customer_notifications`; the one-open-prompt and one-live-link indexes; `deposit_settings` check on the Telegram limit.
- Worker: `telegram.send` (log transport, 429 with `retry_after`, 403, skipped without a link, second run no-op); the card job (new card, edit on decision, new card after a clearer-receipt round); the reminder (outside hours, at the target, the 30-minute repeat, opening-time counting with fixed instants); the summary (`dedupe_key`, contents from fixtures); the alert channel reading the linked chat.
- Unit (contracts, 100% coverage): switch defaults and the store status derivation; the method state of SW6; the notification params schemas; callback data parsing and length; the reminder's due computation.
- E2E with RTL screenshots: store at phone width, dark: the header bell with a badge, `/notifications` (list, empty), the account preferences, the stop banner and the disabled deposit wizard. Admin, light and dark: `/settings/switches` with history, the confirm dialog, the global banner, `/settings/telegram` in its three states.

## Implementation notes
- Suggested PR split, each leaving `main` green:
  1. F26 switches: contracts, db, the `settings` module, the deposit creation lock and options states, the registration switch replacing `REGISTRATION_OPEN`, the store banner and wizard states, the admin switches page and banner (Telegram notices are inserted as `telegram_messages` rows only once PR 3 lands; until then the change has no message).
  2. F27 notifications: `notifyCustomer` in `packages/db`, the call sites of NT2, the notification routes and the SSE stream with the LISTEN fan-out, the store bell, page, preferences and live refresh.
  3. F07 Telegram: link tables and routes, the webhook and bot flows, the worker jobs, the alert channel change, the fake-update CLI, the settings pages, nginx.
- Module layering (architecture rules): `settings` and `notifications` stay below the domain modules. `telegram` is a domain module above `deposits` and `settings`: it calls `DepositReviewService`, `UsdtReviewService` and `SettingsService`; `deposits` never imports `telegram` (it only queues `telegram.deposit-card` by queue name).
- Update `docs/architecture.md` (modules `settings`, `notifications`, `telegram`; the Telegram request flow; worker jobs), `deploy/` nginx and environment, `.env.example` (remove `REGISTRATION_OPEN` and `TELEGRAM_ALERTS_CHAT_ID`; add `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_TRANSPORT`), `docs/deployment.md` (creating the bot, setting the webhook) and the commands table.
