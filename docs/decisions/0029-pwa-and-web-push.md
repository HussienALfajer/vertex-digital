# 0029 — PWA without page caching, and self-hosted web push bound to sessions

Status: Accepted · Date: 2026-10-11

## Context
F24 asks for an installable store with an offline shell and web push for the customer's events. A service worker can cache pages and data, which would make prices, balances and order states stale on a store where money moves, and would leave account data on shared phones. Web push sends customer data through the browsers' push services (Google FCM, Mozilla, Apple, Microsoft) and onto lock screens; FCM may also be unreachable from Syria. The worker would POST to URLs that browsers, and so customers, hand us. The owner settled the choices in the S15 interview (2026-10-11).

## Decision
- **No page or data caching:** the service worker caches only a self-contained `/offline` page and serves it when a navigation fails. Pages, API answers, images and account data always come from the network. No offline browsing of the catalog in V1.
- **Self-hosted web push with VAPID:** the worker signs and encrypts pushes itself (`web-push`); no third-party push provider account. The private key lives only in the worker's server environment; the API serves the public key.
- **Push follows email events:** every event that sends an email also pushes (owner, 2026-10-11), with a per-event push switch beside the email switch, on by default; center-only events and the orders of a checkout push nothing.
- **Minimal lock-screen content:** order numbers, pack names, deposit reference codes, ticket numbers and counts only; never amounts, codes, player IDs, reasons, messages or names.
- **Subscriptions bound to sessions:** a device's subscription is deleted with the session that registered it, and sign-out unsubscribes the browser, so a shared or resold phone stops receiving the previous customer's pushes. At most 10 devices per customer.
- **Allowed push hosts only:** a subscription endpoint must be `https:` on a known push service host, checked by the API and again by the worker before every send.
- **Asked at the right moment:** the browser permission prompt opens only from the customer's tap on a card shown after a purchase or deposit, or from the device switch; install is offered in the account menu and footer, with "Add to Home Screen" steps on iPhone, where push requires the installed app.
- **Push is a convenience:** the notification center and email remain the channels of record; a push that cannot be delivered within 24 hours is dropped.

## Consequences
- The store stays as fresh as without a service worker, and the first-load budgets do not grow (registration is a constant inline script).
- Pushes may not arrive on Android phones in Syria if FCM is blocked; acceptance checks it on real devices after the Phase 3 deploy, and nothing depends on it.
- A session ending (expiry, revoke, password change) silently stops pushes on that device until the customer signs in again there, when the store re-registers the existing subscription without a prompt.
- Adding a push service host, or caching anything beyond `/offline`, needs a change to this record.
