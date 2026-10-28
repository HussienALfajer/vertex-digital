# S15 — PWA and web push (F24)

Status: Approved · Date: 2026-10-11 · Scope: `docs/product/v1-scope.md` §F24 (§F27 channels) · ADRs: 0002, 0007, 0008, 0009, 0011, 0012, 0014, 0015, 0029

## Summary
Customers wait for an order or a deposit with the store open, or they come back later to check; the notification center and email (S05) only reach them when they look. S15 makes the store an **installable PWA** (manifest, icons, a service worker, an "offline" page that never stores prices or account data) and adds **web push** (VAPID, sent by our own worker, no third-party push provider account) as a third channel beside email and the center: every event that sends an email also sends a short push to each device where the customer turned push on, with the order number and pack name but never amounts, codes or player IDs. Push is asked for after the customer's first purchase or deposit, controlled per event next to the email switch, and stops on a device when its session ends.

## In scope / out of scope
- In:
  - Web app manifest, icons (including a maskable icon), `display: standalone`, shortcuts to `/orders` and `/wallet` (rules PW).
  - Service worker at `/sw.js` (scope `/`): the offline page, push display and notification taps; no caching of pages, API answers or account data (rules SW).
  - "ثبّت التطبيق" in the account menu and the footer; iPhone and iPad steps for "Add to Home Screen" (rules IN).
  - Push subscriptions per device, bound to the session (rules PS), per-event push preferences (rules PP), the `push.send` worker job (rules PD), the lock-screen texts (rules PT).
  - The permission card after the first purchase or deposit, and the device switch in the preferences (rules PC).
  - Admin: the number of push devices on the customer profile (owner, 2026-10-11).
- Out (later or never):
  - Push to the admin: the admin has Telegram (S05); not in V1.
  - Marketing or broadcast pushes (offers, new games): not in V1; pushes only follow the customer's own events.
  - Push for `order_delayed` and `order_paid` (center-only events, S08, S09): not in V1 (owner, 2026-10-11: every event that has an email, nothing more).
  - Reading public pages offline (cached home or game pages): not in V1 (owner, 2026-10-11): offline shows only the offline page.
  - A home-page install card: not in V1 (owner, 2026-10-11); install lives in the menu, the footer and the permission card.
  - Push delivery statistics in the panel: not in V1 (owner, 2026-10-11).
  - A list of the customer's push devices in the store: not in V1; the customer controls the current device and the per-event switches.
  - Native apps (scope §6), Telegram for customers (not planned).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the push public key | Public | Anyone |
| Register or refresh this device's push subscription | Customer (session) | Signed-in customer, frozen included (they still get refunds and replies) |
| Remove this device's push subscription | Customer (session) | Signed-in customer; only a subscription of their own |
| Read and change push preferences per event | Customer (session) | Signed-in customer |
| See the number of push devices on a customer's profile | Admin | The admin |
| Send pushes | Worker | System (`push.send` job) |

## Data

### `push_subscriptions` (new, `notifications` module)
A device registration, not a business record: deleted when its session ends, when the customer turns push off on the device, or when the push service says it is gone (conventions test entry: "A device registration (S15 PS): deleted when its session ends or the push service refuses it, never archived").

| Field | Type | Rules |
|---|---|---|
| `id` | uuid v7 | PK |
| `customer_id` | uuid | FK `customers`, not null |
| `session_id` | uuid | FK `customer_sessions` **`ON DELETE CASCADE`**, not null: the subscription lives only as long as the session that registered it (PS4) |
| `endpoint` | text | not null, **unique**; `https:` on an allowed push service host (PS2); at most 1,024 characters |
| `p256dh` | text | not null; the browser's public key (base64url, 65 bytes decoded) |
| `auth` | text | not null; the browser's auth secret (base64url, 16 bytes decoded) |
| `vapid_key_id` | text | not null; the first 16 characters of the base64url VAPID public key it was made with (PS7) |
| `failures` | integer | not null, default 0; consecutive transient failures (PD5) |
| `last_sent_at` | timestamptz | nullable; the last accepted delivery |
| `created_at`, `updated_at` | timestamptz | `timestamps()` |

Indexes: unique `endpoint`; `(customer_id)`; `(session_id)`. Grants (ADR 0014): the app role selects, inserts, updates and deletes.

`p256dh` and `auth` are not secrets of the store: with them alone nobody can push to the device, because the push service only accepts messages signed with the VAPID private key the subscription was made for. They are never logged.

### `notification_preferences` (changed)
- Add `push boolean not null default true`. A missing row still means both channels on (S05 NT8). A row created by changing one channel takes the default for the other.

### Contracts
- `PUSH_NOTIFICATION_EVENTS = EMAIL_NOTIFICATION_EVENTS` (owner, 2026-10-11): `deposit_credited`, `deposit_rejected`, `deposit_receipt_requested`, `wallet_adjusted`, `order_delivered`, `order_partially_refunded`, `order_refunded`, `order_cancelled`, `checkout_finished`, `ticket_replied`.
- `PUSH_SERVICE_HOSTS`: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, and hosts ending in `.notify.windows.com` (Edge). Adding a host is a code change with review.
- `pushSubscriptionSchema` (the browser's `PushSubscription.toJSON()`: `endpoint`, `expirationTime` nullable, `keys.p256dh`, `keys.auth`), `pushConfigSchema` (`{ publicKey: string | null }`), `removePushSubscriptionSchema` (`{ endpoint }`).
- `notificationPreferencesSchema` gains `push: record(event, boolean)`; `updateNotificationPreferenceSchema` becomes `{ event, email } | { event, push }` (exactly one channel per change). `push` is accepted only for `PUSH_NOTIFICATION_EVENTS`.
- Job `push.send` in `jobs.ts`: `{ notificationId: uuid, subscriptionIds?: uuid[] }`.
- Error codes: `PUSH_NOT_CONFIGURED`, `PUSH_ENDPOINT_REFUSED`.
- Audit action `customer.push_preference_changed`: `{ event, push }` (the S05 action keeps its shape for existing rows).
- `adminCustomerSchema.counts.pushDevices`: integer ≥ 0.

### Environment
- Worker: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` the sending mailbox, default from `EMAIL_FROM`), `PUSH_TRANSPORT` (`web-push` in production, `log` locally and in tests: writes each payload to a file like `TELEGRAM_TRANSPORT=log`). API: `VAPID_PUBLIC_KEY` only. The private key exists only in the worker's environment; `.env.example` holds fake values; `pnpm db:setup-local` generates a local key pair into `.env`.
- Push is **configured** when the API has a public key. Without one, `GET /api/push/config` answers `publicKey: null` and the store shows no push controls; the worker refuses to start with only one of the pair.

## States and rules

### PWA (PW)
- PW1. `apps/store/src/app/manifest.ts` serves `/manifest.webmanifest`: `id: "/"`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `lang: "ar"`, `dir: "rtl"`, `name` and `short_name` "VERTEX DIGITAL", a description from i18n, `background_color` and `theme_color` from the dark theme tokens of `brand/identity.md`, icons 192 and 512 (`purpose: any`) and a 512 maskable icon with the mark inside the safe zone (new file in `brand/logo/png/`, imported, never copied into `public/`), and two shortcuts: "طلباتي" `/orders`, "المحفظة" `/wallet`.
- PW2. The layout links the manifest and sets `theme-color` and the Apple web-app meta tags (`apple-mobile-web-app-capable`, title, status bar style) so an installed iPhone app opens full screen.

### Service worker (SW)
- SW1. `/sw.js` is served with `Content-Type: text/javascript`, `Cache-Control: no-cache` and scope `/`. It is a constant script written in the repository (ADR 0015) with the build id in it, so every deploy installs a new version; the new worker calls `skipWaiting` and `clients.claim` (safe: it caches nothing a page depends on).
- SW2. Registration: a constant inline script in the layout registers `/sw.js` after the `load` event when `serviceWorker` is supported, and keeps the `beforeinstallprompt` event on `window` for IN1. No bundle JS is added to the first load of any page.
- SW3. **Caching**: at install, the worker caches only `/offline` (one self-contained response, SW5) in a cache named with the build id, and deletes older caches at activate. Navigations go to the network; when the network fails, it answers the cached `/offline`. Every other request (`/api/*`, `/_next/*`, images, fonts) goes to the network untouched; the browser's HTTP cache handles static files as today. Nothing a customer owns and no price is ever stored by the worker (owner, 2026-10-11).
- SW4. Account and public pages behave exactly as without the worker when online: no stale prices, no stale balances.
- SW5. `/offline` is a static, self-contained page: inline styles and the inline SVG logo, the system Arabic font stack, no external file, no script except a constant `onclick` on "أعد المحاولة" that reloads. Its text comes from `ar.json` at build time: "لا يوجد اتصال بالإنترنت" and "تحقق من اتصالك ثم أعد المحاولة. رصيدك وطلباتك بأمان." It is `noindex` and not in the sitemap.
- SW6. **Push display**: on `push`, the worker parses the JSON payload (PT1) and always shows a notification (`userVisibleOnly`): `title`, `body`, `icon` the 192 icon, `badge` a monochrome mark, `lang: "ar"`, `dir: "rtl"`, `tag` (PT3), `renotify: true`, `data.url`. A payload that does not parse shows the generic text "لديك إشعار جديد" linking to `/notifications`.
- SW7. **Tap**: on `notificationclick`, the notification closes; `data.url` is used only if it is a path starting with a single `/` (otherwise `/notifications`). An open store window is focused and navigated to it; otherwise a new window opens it. The page then loads its data as usual; the center marks nothing read on its own (S05 NT5 is unchanged).

### Install (IN)
- IN1. "ثبّت التطبيق" appears in the account menu and in the footer only when installing is possible: a kept `beforeinstallprompt` (Chromium browsers: the button calls `prompt()`), or iOS/iPadOS Safari not in standalone mode (the button opens a sheet with the three steps: Share, "Add to Home Screen", "Add", with the system icons drawn from the design system). It is hidden in standalone mode and after `appinstalled`.
- IN2. Nothing about installing is shown on page load; no home-page card (owner, 2026-10-11).

### Subscriptions (PS)
- PS1. A device registers with `PUT /api/push/subscription` the browser's subscription, made with the public key of `GET /api/push/config` (`applicationServerKey`). The API upserts by `endpoint`: a new row, or the existing row moved to this customer and this session with new keys. The answer is 204.
- PS2. The API refuses (`PUSH_ENDPOINT_REFUSED`) an endpoint that is not `https:`, has a port, user info or an IP address as host, or whose host is not in `PUSH_SERVICE_HOSTS`; keys that are not base64url of the right decoded length are `VALIDATION_FAILED`. The worker checks the host again before every send (the request is to a URL a customer gave us).
- PS3. At most **10** subscriptions per customer: registering an 11th deletes the customer's subscription with the oldest `updated_at`, in the same transaction.
- PS4. A subscription is bound to the session that registered it. When the session ends (sign-out, "sign out" on that session or "sign out everywhere", the admin's revoke, a password or email change that signs out other sessions, idle deletion or expiry), the row goes with it by the foreign key. The worker also skips any subscription whose session has passed `expires_at` (PD2).
- PS5. **Sign-out on this device** (header menu): the store first calls `pushManager.getSubscription()` and `unsubscribe()` (best effort, never blocking sign-out); the row goes with the session.
- PS6. **Refresh**: on every signed-in page load, when push is configured, `Notification.permission` is `granted` and the browser holds a subscription made with the current public key, the store sends `PUT /api/push/subscription` once per tab session (kept in `sessionStorage` behind try/catch). This rebinds a device whose session ended without a sign-out (expiry, revoke elsewhere) to the new session after the next sign-in, without a new prompt. It never subscribes a browser that holds no subscription: that needs the customer's tap (PC2).
- PS7. **Key change**: if the browser's subscription was made with another key (its `options.applicationServerKey` differs from the served key), PS6 unsubscribes it and, with permission still `granted`, subscribes again with the new key, then registers it. Server rows with another `vapid_key_id` are skipped by the worker and deleted.
- PS8. `DELETE /api/push/subscription` with `{ endpoint }` deletes the row only when it belongs to the signed-in customer; it answers 204 either way (no way to probe other endpoints).

### Preferences (PP)
- PP1. The preferences card on `/account` (S05 NT8) gets a second column "الهاتف" next to "البريد" for every event of `PUSH_NOTIFICATION_EVENTS`, all on by default (owner, 2026-10-11). Changing one writes or updates its row and the audit entry `customer.push_preference_changed`, in one transaction.
- PP2. The push column is shown only when push is configured. While this device has no subscription, above the table: "إشعارات الهاتف غير مفعّلة على هذا الجهاز" with the device switch (PC4); the per-event switches stay editable (they apply to all the customer's devices).
- PP3. A preference applies to pushes sent after the change: the worker reads it at send time (PD2).

### Delivery (PD)
- PD1. `notifyCustomer` (S05 NT1) also queues one `push.send` job with `{ notificationId }`, in the same transaction, when the event is in `PUSH_NOTIFICATION_EVENTS`, the call is not a center-only call (`email: false`, S10 CT8: the orders of a checkout push nothing; their `checkout_finished` pushes once) and the customer has at least one subscription. Nothing about push is decided by the email preference, and the reverse.
- PD2. The worker job loads the notification and, at run time: the customer's push preference for the event (missing means on); and the subscriptions of the customer (or the given `subscriptionIds` of a retry) whose session still exists and has not expired and whose `vapid_key_id` matches the current key. Nothing is sent if the preference is off, or the notification is older than 24 hours.
- PD3. It renders the payload (PT1) once and sends it to each subscription with `web-push` (aes128gcm, VAPID JWT for the endpoint's origin), `TTL` 24 hours minus the notification's age, `Urgency: high` for order and deposit events and `normal` for `wallet_adjusted`, `checkout_finished` and `ticket_replied`, and `Topic` set to the tag (PT3) so a push service replaces an undelivered older message for the same record. Each request times out after 10 seconds. Sends to several devices run with a concurrency of 5.
- PD4. Outcome per subscription: 201/202 sets `last_sent_at` and `failures = 0`; **404 or 410** deletes the row; **400, 403 or 413** is a bug or a key mismatch: the row is kept, the job logs it and reports one Sentry event per job (A13), never the payload or the keys; **429, 5xx, timeout or network error** is transient: `failures + 1`.
- PD5. Transient failures are retried once in a new `push.send` job with only those `subscriptionIds`, 60 seconds later, then once more 5 minutes later; after that the push is dropped (the center and the email have it). A subscription with 20 consecutive transient failures is deleted.
- PD6. Safe to run twice: a push is not money and a repeat shows as the same notification (same `tag`, PT3), replacing the first. The job holds no transaction while it calls push services.
- PD7. `PUSH_TRANSPORT=log` writes each would-be request (endpoint host, headers, payload) to a file per notification under the worker's log folder for local testing and E2E; nothing leaves the machine.

### Texts (PT)
- PT1. The payload is JSON, under 1 KB: `{ title, body, url, tag }`, rendered in Arabic by the worker from `apps/worker/src/jobs/push/push-texts.ts` (next to the email templates, same i18n rules: Latin digits, no exclamation marks).
- PT2. **What a push never contains** (owner, 2026-10-11): amounts in any currency, codes or PINs, player IDs or any account field value, deposit rejection reasons, ticket messages, admin notes, the customer's name or email. Allowed: the order number, the pack's Arabic name and quantity, the deposit's reference code, the ticket number, counts.
- PT3. Texts, links and tags (title is "VERTEX DIGITAL" for all; the body below; `url` per S05 NT4 and the later specs):

| Event | Body | `url` | `tag` |
|---|---|---|---|
| `order_delivered` | "تم تسليم طلبك {orderNumber}: {productNameAr}" (with "× {quantity}" when above 1) | `/orders/{orderId}` | `order-{orderId}` |
| `order_partially_refunded` | "سُلّم جزء من طلبك {orderNumber} وأُعيد الباقي إلى رصيدك" | `/orders/{orderId}` | `order-{orderId}` |
| `order_refunded` | "لم نتمكن من تسليم طلبك {orderNumber}، وأُعيد المبلغ إلى رصيدك" | `/orders/{orderId}` | `order-{orderId}` |
| `order_cancelled` | "أُلغي حجزك {orderNumber}. لم يُخصم شيء من رصيدك" | `/orders/{orderId}` | `order-{orderId}` |
| `checkout_finished` | "اكتملت طلبات سلتك: {delivered} من {orderCount} سُلّمت" (adds "وأُعيد الباقي إلى رصيدك" when any refund) | `/orders?checkout={checkoutId}` | `checkout-{checkoutId}` |
| `deposit_credited` | "أُضيف إيداعك {referenceCode} إلى رصيدك" | `/wallet/deposits/{depositId}` | `deposit-{depositId}` |
| `deposit_rejected` | "لم نتمكن من قبول إيداعك {referenceCode}. افتحه لمعرفة السبب" | `/wallet/deposits/{depositId}` | `deposit-{depositId}` |
| `deposit_receipt_requested` | "نحتاج صورة أوضح لإيصال إيداعك {referenceCode}" | `/wallet/deposits/{depositId}` | `deposit-{depositId}` |
| `wallet_adjusted` | "تغيّر رصيدك. افتح المحفظة لمعرفة التفاصيل" | `/wallet` | `wallet` |
| `ticket_replied` | "ردّ فريق الدعم على تذكرتك {number}" | `/support/{ticketId}` | `ticket-{ticketId}` |

  The final wording is checked against `brand/identity.md` §10 in the implementation PR; the content limits of PT2 are not.

### Permission card and device switch (PC)
- PC1. **When** (owner, 2026-10-11): a calm card "فعّل الإشعارات لنخبرك فور التسليم" (on a deposit page: "فور إضافة رصيدك") appears on the order page `/orders/<id>` and the deposit page `/wallet/deposits/<id>` when all hold: push is configured; the browser supports push or is iOS/iPadOS Safari not installed; `Notification.permission` is `default` (or iOS not installed); this device has no subscription; the card was not closed on this device in the last 30 days (`localStorage` behind try/catch; without storage it shows every time and closing hides it for the visit). It never appears on page load elsewhere, and the browser's prompt is never opened without a tap.
- PC2. **Tap "فعّل"**: `Notification.requestPermission()`; on `granted`, `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` and `PUT /api/push/subscription`, then the card says "تم. ستصلك الإشعارات على هذا الجهاز" and disappears on the next visit. On `denied`: the card shows how to allow notifications from the browser's site settings and stops showing. On `default` (dismissed prompt): treated as "later" (30 days).
- PC3. **iOS/iPadOS Safari not installed**: push needs the installed app, so the card says "لتصلك الإشعارات على آيفون، ثبّت التطبيق أولاً" with the install steps of IN1; inside the installed app the card behaves as PC2.
- PC4. **Device switch** on `/account` and at the top of `/notifications`: "إشعارات الهاتف على هذا الجهاز", on when this device has a subscription. Turning on is PC2 (one tap, no prompt when permission is already granted); turning off unsubscribes the browser and calls `DELETE /api/push/subscription`. With permission `denied`, the switch is disabled with the browser-settings hint. Hidden when push is not configured or the browser cannot do push (iOS not installed shows the install hint instead).
- PC5. Frozen customers (S12) see and use everything here: their refunds and replies still notify.

## Money flows
None. S15 moves no money and reads no balance; it only delivers the existing notifications on one more channel.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/push/config` | Public, rate-limited per IP | — | `pushConfigSchema` (`publicKey` or null), `Cache-Control: public, max-age=300` | `RATE_LIMITED` |
| `PUT /api/push/subscription` | Customer | `pushSubscriptionSchema` | 204 | `PUSH_NOT_CONFIGURED`, `PUSH_ENDPOINT_REFUSED`, `VALIDATION_FAILED`, `RATE_LIMITED` (20 an hour per customer) |
| `DELETE /api/push/subscription` | Customer | `removePushSubscriptionSchema` | 204 (also when nothing matched) | `VALIDATION_FAILED`, `RATE_LIMITED` (20 an hour per customer) |
| `GET /api/account/notification-preferences` | Customer | — | `notificationPreferencesSchema` (now `email` and `push`) | — |
| `PUT /api/account/notification-preferences` | Customer | `updateNotificationPreferenceSchema` (`{ event, email }` or `{ event, push }`) | `notificationPreferencesSchema` | `VALIDATION_FAILED` (push for an event outside `PUSH_NOTIFICATION_EVENTS`) |
| `GET /api/admin/customers/:id` | Admin | — | `adminCustomerSchema` with `counts.pushDevices` | as today |

Every customer route also answers `UNAUTHORIZED` and the guard's codes. The API never calls a push service.

## Jobs and integrations
- `push.send` (worker, `notifications` jobs folder `apps/worker/src/jobs/push/`): queued by `notifyCustomer` (PD1) and by itself for retries (PD5); pg-boss retry off (the job retries per device itself); safe to run twice (PD6).
- Push services: FCM (Chrome, Android, Opera, Samsung Internet), Mozilla autopush (Firefox), Apple (`web.push.apple.com`, Safari and installed iPhone apps from iOS 16.4), WNS (Edge). Outbound HTTPS from the worker only; the VPS needs no new inbound route.
- **Reachability from Syria** (owner, 2026-10-11): Chrome on Android receives pushes through Google's FCM, which may be blocked or slow on Syrian networks. Push is a convenience: the center and email always carry the event. The owner's acceptance includes a real Android and iPhone inside Syria after the Phase 3 deploy; if pushes do not arrive, the feature stays on and nothing else changes.
- Library: `web-push` (MIT) in the worker, the only new runtime dependency.
- `pnpm db:setup-local` generates the VAPID pair into `.env` when missing.

## Screens
- **Store, every page**: no visible change; the manifest, theme color and the service worker registration (SW2). Installed, the store opens full screen with the dark background color while loading.
- **Account menu and footer**: "ثبّت التطبيق" (IN1); the iOS steps sheet (bottom sheet at phone width, dialog on desktop).
- **`/orders/<id>` and `/wallet/deposits/<id>`**: the permission card (PC1–PC3) under the status block, loaded with `next/dynamic` only when its conditions hold (no first-load cost); states: offer, working (button busy), done, denied hint, iOS install hint; an API failure on registration says "تعذّر تفعيل الإشعارات. حاول مرة أخرى" and keeps the button.
- **`/account` preferences card**: the "الهاتف" column (PP1–PP2) and the device switch (PC4); loading skeleton and error retry as today.
- **`/notifications`**: the device switch at the top (PC4) when push is configured and not yet on for this device.
- **`/offline`** (SW5): the logo, the two sentences and "أعد المحاولة", centered, dark.
- **Admin customer profile**: in the counts block, "إشعارات الهاتف: مفعّلة على {n} جهاز" or "غير مفعّلة" (owner, 2026-10-11). No other panel change.
- E2E screenshots, RTL, dark and light, phone and desktop: the permission card (offer, done, denied, iOS), the preferences card with the push column, the iOS steps sheet, `/offline`, and the admin profile counts.

## Audit and notifications
- Audit: `customer.push_preference_changed` (PP1). Registering or removing a device is not audited: it is device state, like a session, and the session list (S01) already shows the devices.
- Notifications: S15 adds the push channel to the events of `PUSH_NOTIFICATION_EVENTS` (PD1). Telegram: none (push failures are not alerts; a 403 burst reaches Sentry, A13). Emails unchanged.

## Abuse and fraud
| Abuse | Control |
|---|---|
| SSRF: a customer registers an endpoint pointing to an internal or arbitrary host, and the worker POSTs to it | `https:` only, host in `PUSH_SERVICE_HOSTS`, no IP hosts, ports or user info (PS2), checked by the API and again by the worker before each send; 10-second timeout; no redirects followed |
| A shared or sold phone keeps receiving the previous customer's pushes | Subscriptions are bound to the session (PS4); sign-out unsubscribes the browser (PS5); "sign out everywhere" and the admin's revoke remove them |
| A stolen session registers the thief's device to watch the victim's orders | Pushes carry no amounts, codes or IDs (PT2); revoking the session removes the device (PS4); the session list shows the session (S01) |
| Lock-screen exposure of private details | PT2 content limits, checked by a unit test over every event's rendered text |
| Flooding the table with fake subscriptions | 20 registrations an hour per customer, 10 per customer (PS3), endpoint unique, signed-in customers only |
| Moving someone else's endpoint to my account (endpoint guessing) | Endpoints are unguessable capability URLs from the push service; an upsert also needs keys only that browser has to decrypt anything; `DELETE` answers 204 either way (PS8) |
| Phishing through a notification tap | `url` is always rendered by the worker from our routes; the service worker opens only same-origin paths (SW7) |
| A malicious script registering its own service worker | CSP `worker-src 'self'` (already in `vertexdigital-store-csp.conf`), `/sw.js` is a constant file in the repository (ADR 0015) |
| Stale or forged prices from a cached page | The service worker caches no page except `/offline` (SW3) |
| VAPID private key leak | Only in the worker's server environment; never in the repo, logs or the API; rotation follows PS7 |

## Edge cases
1. A notification is written but its transaction rolls back: no `push.send` job exists (same transaction, PD1).
2. The customer turns the event's push off between the event and the send: no push (PD2); the opposite also holds (PP3).
3. The session ends between queueing and sending: the row is gone or expired; nothing is sent to that device (PD2).
4. The worker is down for a day: notifications older than 24 hours are not pushed (PD2); the center and email have them.
5. The same endpoint is registered by two customers on one browser in turn: the upsert moves it to the latest customer and session (PS1); the previous customer's pushes stop there.
6. Permission revoked in the browser settings: the push service answers 404/410 on the next send and the row is deleted (PD4); the switch shows off on the next visit.
7. A checkout of several orders: no push per order, one `checkout_finished` push (PD1).
8. Two events for one order in quick succession (delivered after a delay notice, or a partial refund): the same `tag` replaces the earlier notification on the device (PT3).
9. The VAPID key is rotated: devices re-subscribe on their next signed-in visit (PS7); until then the worker skips and deletes old-key rows.
10. Push is not configured (no keys) in an environment: no job is queued (`notifyCustomer` checks only for subscriptions, and none can exist), no controls show.
11. iPhone in Safari, not installed: no subscribe attempt; the card and switch show the install hint (PC3).
12. A browser without service workers or push (old browsers, some in-app webviews): no install item, no card, no switch; everything else works.
13. Offline during sign-out: the browser unsubscribe may fail; the server row goes with the session anyway (PS5).
14. The 11th device: the oldest is removed (PS3) and stops receiving.
15. A frozen or archived customer: frozen keep receiving (PC5); archiving signs the customer out (S12), which removes the devices.
16. The service worker cannot fetch `/offline` at install: install fails and the browser retries on the next visit; pages work without it.
17. A new deploy while a tab is open: the new worker activates (SW1); since it caches nothing a page uses, the open page is unaffected.

## Open questions
None.

## Acceptance
- **Owner, local** (`pnpm dev`, a test customer, `PUSH_TRANSPORT=web-push` with the local keys from `pnpm db:setup-local`, Chrome on the computer):
  1. Open the store in Chrome: the install icon appears in the address bar; the account menu shows "ثبّت التطبيق"; install it and open it: full screen, dark.
  2. Place an order with the fake supplier (`order:place` or the buy box); on the order page tap "فعّل" on the card and allow: the card confirms.
  3. Script the next order delivered (`supplier:fake --order <offer> delivered`) and buy again with the store closed: a system notification "تم تسليم طلبك …" arrives; tapping it opens the order page.
  4. On `/account`, turn off "الهاتف" for "تسليم الطلب" and buy again: no push, the center and email still get it.
  5. Credit a fake USDT deposit (`usdt:fake-transfer`): a push "أُضيف إيداعك …" without the amount.
  6. Sign out, then deliver an order of that customer from another browser session: no push arrives.
  7. Stop the network (DevTools offline) and reload: the offline page; back online, "أعد المحاولة" loads the store.
  8. The admin opens the customer profile: "إشعارات الهاتف: مفعّلة على 1 جهاز" (0 after step 6, until enabled again).
- **Owner, after the Phase 3 deploy, in Syria**: repeat steps 2–3 on an Android phone (Chrome) and on an iPhone with the app installed (iOS 16.4 or later); record whether pushes arrive and how fast.
- **Tests**:
  - Unit (contracts): `PUSH_SERVICE_HOSTS` matching (allowed hosts, subdomains of `notify.windows.com` only, IP hosts, ports, user info, `http:` refused), the subscription schema's key lengths, the preferences update union.
  - Unit (worker): every event's rendered payload: under 1 KB, Arabic, no amount, code, player ID, reason or name (PT2), the `url` and `tag` of PT3; the outcome mapping of PD4; TTL from the notification's age.
  - DB/integration: `notifyCustomer` queues `push.send` only with a subscription and not for center-only calls; the session foreign key removes rows on session delete; the 10-device cap; the upsert moving an endpoint between customers; preference `push` default and the audit entry in the same transaction.
  - API: each route for success, 401, 403 (admin session on customer routes), another customer's endpoint on `DELETE` (204, row kept), the endpoint refusals, rate limits, `PUSH_NOT_CONFIGURED`; the admin profile's `pushDevices`.
  - Worker: the job with the `log` transport (sent to live subscriptions only, preference off, expired session, old key, notification older than 24 hours), a mock push service answering 201, 410, 429 and 403 (row deleted, retried with only failed ids, Sentry once), the host re-check.
  - Store unit: the permission card's conditions (PC1), the URL check of the tap handler (SW7), the subscription refresh rule (PS6, PS7).
  - E2E: the manifest and `/sw.js` served with their headers; the offline page with the browser offline; the card flow with permission granted (Playwright `context.grantPermissions(['notifications'])`, `PUT` mocked), denied and the iOS hint; the preferences push column and the device switch; first-load budgets unchanged (`e2e/store.spec.ts`); the admin profile count; RTL screenshots listed under Screens.

## Settled in implementation
- PR plan: PR 1 is contracts, db, api and worker; PR 2 is the store (PWA, install, push client, card, switches, preferences column), the admin profile line and E2E.
- PR 1:
  - `PUSH_NOTIFICATION_EVENTS` and `isPushNotificationEvent` live in `notifications.ts` beside the email events (the preferences union needs them); `push.ts` holds the hosts, `pushEndpointAllowed` (PS2), `base64UrlByteLength`, `vapidKeyId` (PS7), the limits and the subscription, removal and config schemas. Both preference channels list every event, as `email` already did.
  - Status codes: `PUSH_NOT_CONFIGURED` is 409, `PUSH_ENDPOINT_REFUSED` 400. `GET /api/push/config` is limited to 60 a minute per address. The store catalog explains both codes; the admin never receives them.
  - The 20 changes an hour count registrations and removals together, per customer, in `customer_rate_limits`. The counter (`withinLimits`) moved from the api `auth` module to `packages/db/src/rate-limits.ts`, so `notifications`, which sits below `auth`, can count without an import cycle.
  - PS1 and PS3 run under an advisory lock per customer; the cap deletes beyond the 10 newest by `updated_at`, stamped with `clock_timestamp()` so the lock's order decides. A re-registration of the same endpoint clears `failures`.
  - `push.send` carries `retry` (1 or 2) beside `subscriptionIds`, so a retry knows its delay and that the second is the last (PD5). pg-boss retries are off (`PUSH_SEND_OPTIONS`); a fault of ours still fails the job with the usual alert.
  - `Topic` is limited by RFC 8030 to 32 base64url characters, fewer than a tag with a UUID: it is the first 32 characters of the tag's SHA-256 in base64url (PD3).
  - `push_subscriptions.customer_id` has no cascade: test clean-ups delete devices before customers. The admin's `pushDevices` counts devices of unexpired sessions, whatever their key.
  - The API also refuses (`VALIDATION_FAILED`) a `p256dh` that is not a P-256 point; a stored device whose keys the worker cannot encrypt for is deleted like a 404. A device whose endpoint fails the worker's host re-check is deleted (`host_refused`). Any answer outside PD4's lists (a 3xx: redirects are not followed) is transient.
  - `PUSH_TRANSPORT=log` appends one JSON line per device to `<PUSH_LOG_DIR>/<notificationId>.jsonl`: the host, `TTL`, `Urgency`, `Topic` and the payload; never the keys or the VAPID JWT. `VAPID_SUBJECT` defaults to `mailto:` and `EMAIL_FROM`.
  - The checkout text counts `delivered` as the event carries it, and adds "وأُعيد الباقي إلى رصيدك" when `refundedUsdUnits` is above 0. PT3's texts were checked against `brand/identity.md` §10: no exclamation marks, Latin digits.
- PR 2:
  - The icons: `brand/logo/png/icon-maskable-512.png` (the sand mark at 57% width on full-bleed Vertex Green, inside the 80% safe zone) and `badge-96.png` (the white mark on transparent); `icon-192.png` was 192 × 191 and is re-rendered at 192 × 192 from `icon-512.png`, since the manifest names its size. `theme-color` and both manifest colors are green-950 `#031B17`; the iPhone status bar style is `black` (not translucent: the header would sit under the clock).
  - `/sw.js` and `/offline` are route handlers read per request (`connection()`), so their `Cache-Control: no-cache` is not replaced by Next's header for prerendered routes; the build id is `STORE_BUILD_ID` (or a time-and-pid value) set by `next.config.ts` `generateBuildId` and inlined through `env`. The offline page's logo is the path of `packages/ui` `logo-shapes.ts` (new export `@vertex-digital/ui/brand/logo-shapes`). The worker handles only `GET` navigations; a tap's `url` is kept only when it starts with one `/` and resolves to the store's origin.
  - The registration script calls `preventDefault()` on `beforeinstallprompt`, so Chrome on Android shows no mini-infobar: installing is offered only by "ثبّت التطبيق" (IN2). iOS steps are offered to Safari only (Chrome, Firefox and Edge on iOS are treated as unable).
  - PS6 runs from the signed-in header, in its own chunk (sign-out loads the same chunk on the press), only where `Notification.permission` is `granted`. "Once per tab session" is kept per session: `sessionStorage` holds a digest of the session token the device was last registered with (never the token), set only after the API accepted it, so a new sign-in in the same tab (the installed app after an expiry or a revoke) rebinds the device. PS5 waits at most 1.5 seconds for the browser's `unsubscribe()`; revoking this session from the sessions card does not unsubscribe the browser (PS5 names the header menu), the row goes with the session.
  - The card's "لاحقًا" (and a dismissed prompt) stores the time in `localStorage` `vd-push-card-closed`. The device switch on `/account` sits inside the preferences card above the list, with "إشعارات الهاتف غير مفعّلة على هذا الجهاز" under it while off; on `/notifications` it shows only when push was off at the first read of the visit.
  - The admin line reads "مفعّلة على 1 جهاز", "مفعّلة على جهازين", "مفعّلة على {n} أجهزة" (3–10) or "مفعّلة على {n} جهاز", and "غير مفعّلة" at 0.
  - E2E blocks service workers in every spec but `e2e/pwa.spec.ts` (the API mock routes the page's requests); `e2e/push.spec.ts` replaces `Notification`, the registration and `PushManager` in the page (`e2e/push-browser.ts`), since headless Chromium cannot reach a push service.
