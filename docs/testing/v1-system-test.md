# V1 full system test

The owner's end-to-end test of every V1 feature on production, before the pilot and before a second supplier is added (`docs/ROADMAP.md`, Pilot). One feature at a time, in the order below. Only the feature under test has its steps written; the next feature's steps are written once the current one is accepted.

## How a feature is tested

1. **Steps written:** the feature's section gets its test cases (this file), on the feature's branch. No PR yet.
2. **Run:** the owner runs every case on production and marks it ✅ or ❌, with a note for each ❌ or surprise. Claude can watch the panel, logs and database read-only while the owner runs it.
3. **Fix:** every ❌ goes to the findings log below. Bugs are fixed on the same branch with their own tests, deployed, and the failed cases are run again.
4. **Accept:** when every case is ✅ (or a finding is accepted and logged as a follow-up), the owner accepts the feature.
5. **Ship:** one PR for the feature (this file's results, fixes, docs), merged to `main`. Then the next feature's steps are written.

## Ground rules on production

- **Test customers only.** Registration stays closed except where a case opens it on purpose and closes it again in the same sitting. Test customers are excluded from reports, dashboards and live activity (S01 T1).
- **Real money is small and named.** WDGZone holds about $6: at most three real purchases in the whole test, each written in its case. Failures, refunds and manual fulfilment use the `manual` route on PUBG Mobile 60 UC (cost $0.95, last resort).
- **Failure cases stay under the ban threshold.** fail2ban bans an address after 20 failed sign-ins in 10 minutes for one hour (`deploy/fail2ban`). A case never needs more than 3 deliberate failures; wait 10 minutes between failure cases if in doubt.
- **No secrets in this file.** Never write a password, TOTP code, backup code, receipt image or real customer data here. Refer to test customers as TC1, TC2, TC3.
- **Re-authentication** lasts 5 minutes; a case that needs several sensitive saves does them in one sitting.

### Test accounts

| Name | Use |
|---|---|
| Admin | The single admin account (`info@vertexmedia.pro`), TOTP enrolled |
| TC1 | Main customer: deposits, purchases, cart, saved IDs, notifications, phone |
| TC2 | Administration target: freeze, caps, overrides, archive |
| TC3 | Receiver: gifts, purchases on behalf, compensation |
| SU | Feature 2 only: a real sign-up to test the sign-up flow, archived at the end of feature 2 |

## Feature order

Ordered by dependency: access and its audit trail first, then money in, then what money buys, then operations on top, and the money check last so it covers everything the test did.

| # | Feature | Scope IDs | Why here | Status |
|---|---|---|---|---|
| 1 | Admin access, 2FA and audit log | F02 | Every later step is an admin action that must be authenticated, re-authenticated and audited; the audit log is the tool used to verify the rest | Accepted 2026-10-15 |
| 2 | Customer accounts | F01 | Every customer case needs sign-in, sessions and account emails working | Accepted 2026-10-15 |
| 3 | Exchange rate and SYP display | F04 | SYP deposits and every SYP price depend on it | Accepted 2026-10-15 |
| 4 | Sham Cash deposits | F05 (+ F07, F27 deposit parts) | First money in; the manual review path with its Telegram card and emails | Accepted 2026-10-16 (4.12 step 2 on 2026-10-17) |
| 5 | USDT deposits | F06 | The automatic money-in path | Accepted 2026-10-16 |
| 6 | Wallet and ledger | F03 | Checked once real deposits exist: balances as sums, history, journals | — |
| 7 | Catalog | F08 | What is sold: games, packs, fields, images, states | — |
| 8 | Pricing engine | F10 | Prices, margins, review queue, loss guard | — |
| 9 | Suppliers | F09 | Sync, health, balance, routes, supplier catalog browser, stock | — |
| 10 | Store home, game pages and search | F12, F15 | The customer's way to a product | — |
| 11 | Purchase, fulfilment and live tracking | F13, F11 | The core sale: success, manual route, unknown outcome, failure and refund, reservation | — |
| 12 | Saved player IDs and one-tap recharge | F14 | Builds on a successful purchase | — |
| 13 | Cart, gift top-up and shareable receipt | F16 | Multi-line checkout and gifts on top of purchases | — |
| 14 | Admin purchases | S16 (F11) | Walk-in, on behalf, gift and compensation, owner drawings cap | — |
| 15 | Live orders room and dashboard | F17, F18 | Needs the orders made in 11–14 | — |
| 16 | Customers administration | F19 | Freeze, caps, overrides, signals, archive, on customers with history | — |
| 17 | Support tickets | F23 | Tickets from orders and deposits made earlier | — |
| 18 | Content and live activity | F21, F25 | Pages, FAQ, banners, announcement, activity after real deliveries | — |
| 19 | Notifications, PWA and web push | F27, F24 | Preferences and the full notification center after all event types happened | — |
| 20 | Telegram admin bot | F07 | Commands, cards, reminders and the daily summary across all events | — |
| 21 | Store switches and emergency stop | F26 | Stops everything the earlier features proved working, then restores it | — |
| 22 | Daily reconciliation and reports | F20, F22 | Last: every cent the test moved must reconcile and appear in reports | — |

## Findings log

| ID | Feature | Case | What happened | Severity | Fix (PR) | Status |
|---|---|---|---|---|---|---|
| F1-1 | 1 | Code audit | Admin API answers (audit log, sessions) carried no `Cache-Control`: a shared computer's browser could keep private data in its cache | minor | Every `/api/admin/*` answer defaults to `no-store` (`core/http/admin-no-store.ts`, since F2-10 `private-no-store.ts`), with this file's PR | Fixed |
| F1-2 | 1 | Code audit (1.8) | The own-sessions list kept sessions past their 12 hours or idle for 30 minutes, which sign nobody in | minor | Only live sessions are listed (`AdminAccountService.sessions`), with this file's PR | Fixed |
| F1-3 | 1 | Code audit (1.10) | The backup-codes download released its file at the moment of the click, which can cancel the download in some browsers | minor | Released a second later, with this file's PR | Fixed |
| F1-4 | 1 | Code audit | The re-authentication password and the current password of a password change had no length limit | minor | Bounded at 128 like every password, with this file's PR | Fixed |
| F1-5 | 1 | Second review (another model) | A session opened with the password alone before TOTP was enrolled became a full panel session once TOTP was enrolled in another browser | blocker | Enrolling TOTP ends every other session of the admin (`admin-auth.config.ts`, after hook) | Fixed |
| F1-6 | 1 | Second review | A sign-in sent with `rememberMe: false` got a 24-hour session instead of 12 | major | Every admin session's expiry is capped at 12 hours from its creation (session create hook) | Fixed |
| F1-7 | 1 | Second review | A password change or reset left sign-ins waiting at their TOTP step valid: they proved the old password | major | Both void the admin's pending TOTP steps (`admin_verifications`) | Fixed |
| F1-8 | 1 | Second review | Two password changes at once both succeeded; the second wrote after its session was ended | major | The change locks the admin row and checks the session and the password again inside its transaction | Fixed |
| F1-9 | 1 | Second review | Backup codes could be generated before the CLI-issued password was changed | minor | Refused with `PASSWORD_CHANGE_REQUIRED` | Fixed |
| F1-10 | 1 | Second review | The admin's actions on Better Auth routes (backup codes) did not count as activity for the idle timeout | minor | They update the session's last activity, polling excepted | Fixed |
| F2-1 | 2 | 2.2 | The copy button of the test-customer password said "تعذّر النسخ": the in-app test browser denies `clipboard-write` (checked: permission `denied`, "Document is not focused"). The panel's fallback toast worked as designed | — | Not a bug; re-checked in Chrome at the next password dialog | Closed |
| F2-2 | 2 | 2.3 | `password123` was accepted: the common-password list (SecLists 10k, entries of 8+ characters) lacks it and other well-known ones (`admin123`, `password1234`, `p@ssw0rd`, `aa123456`) | major | None: the owner keeps the current list (the customer chooses the password; rate limits and ALTCHA slow guessing). Step 4 now uses `qwerty123`, which the list refuses | Accepted |
| F2-3 | 2 | 2.3 / 2.5 | The code page showed "محاولات كثيرة خلال وقت قصير". Production records (read-only, owner's approval): "إنشاء الحساب" was sent again with the same unverified `+su` address at 18:27; rule C2 treated it as an existing account, so the first code was voided by a decoy, `+su` got "someone tried to sign up with your email" about itself, and the next "send a new code" presses hit the per-address limits (every hit counts). A customer coming back from the code page to sign up again loses the code the same way | major | A second sign-up for an unverified account no longer voids its pending code (`AuthAccountService.signUp`, S01 C2 and edge case 4a); it still sends only the attempt notice, so the address's owner never receives an account that holds someone else's password (the reviewer refused a first fix that sent a new code for this reason). Test in `apps/api/test/auth.test.ts`, with this file's PR | Fixed |
| F2-4 | 2 | 2.5 | The store's code page uses one plain field, not the slot-style code field the panel uses for TOTP (`OtpField`) | minor | The email code fields (verify email, forgot password, change email) use `OtpField`: six slots, numeric keyboard, one-time-code autofill, a pasted code fills every slot (`features/auth/code-input.tsx`), with this file's PR | Fixed |
| F2-5 | 2 | 2.14 | The owner wants the account emails and screens more professional and distinctive: the logo and the brand colours | minor | Emails: the sand logo on a Vertex Green band (sent inside the email as an inline image, so no client fetches it), the title with the sand start bar, the code in a framed block, the action button in Vertex Green, a footer with the store's address (`email-templates.ts`). Screens: sign-in, sign-up, the code page and forgot password share `AuthFrame`, one card with a brand panel (sand logo, 60° hairlines, three plain promises from `md`) beside the form, with this file's PR | Fixed |
| F2-6 | 2 | 2.14 | Dates said "أكتوبر": `ar-u-nu-latn` gives Egyptian month names, while `brand/identity.md` §10 asks for the names read in Damascus (تشرين الأول) | minor | `ar-SY-u-nu-latn` in the emails, the store and the panel, with this file's PR | Fixed |
| F2-7 | 2 | Review of F2-3 | Before this test (not new): someone who signs up first with another person's address and never verifies keeps a password on that unverified account. If the real owner then presses "send a new code" on the code page and enters it, the owner is signed in to an account whose password the first person knows | major (registration is closed until the pilot) | The owner chose to fix it here. Verifying the email takes the code and the account's password (S01 C7): the store sends the password just typed at sign-up or sign-in (held in the page's memory, never stored) and asks for it after a reload; a right code with another password answers `PASSWORD_MISMATCH` and points to "forgot password". Tests in `apps/api/test/auth.test.ts` and `apps/store/e2e/accounts.spec.ts`, with this file's PR | Fixed |
| F2-8 | 2 | Audit | The change-password and change-email forms compared the current password with no limit but the route's 10 a minute per address: a stolen session could keep guessing the password that lets it move the account to another email | major | 10 current-password checks per customer in 15 minutes, any address (`AuthAccountService.assertPassword`); tested | Fixed |
| F2-9 | 2 | Audit | Creating a test customer and resetting its password issue a working password, yet the API did not require the recent re-authentication the panel already asks for | major | Both routes are `@Sensitive()`; tested | Fixed |
| F2-10 | 2 | Audit | The customer's own private answers (`/api/account`, the session and its device list under `/api/auth`) carried no `Cache-Control`, unlike the admin's (F1-1) | minor | `privateNoStore` (`core/http/private-no-store.ts`) adds `no-store` to `/api/auth` and `/api/account` as well; tested | Fixed |
| F2-11 | 2 | Audit | A name could hold invisible direction marks or overrides (U+202E…), which can make it read as other text in the panel, the audit log or a Telegram card | minor | `fullNameSchema` refuses them; tested | Fixed |
| F2-12 | 2 | Audit (2.3 screenshots) | A field's error stayed under it after the customer corrected it, until the next submit | minor | The account forms clear a field's error as soon as it is edited (`lib/field-errors.ts`, the code fields on change) | Fixed |
| F2-13 | 2 | Audit | The device list read "IP: 5.0.0.1 عنوان" (the address broke the Arabic line), and the sign-in email named an unrecognised device "Unknown" | minor | "عنوان الإنترنت" with the address kept left to right; "غير معروف" in the email; tested | Fixed |
| F2-14 | 2 | Audit (independent review) | An abandoned sign-up could be found with one request and no ALTCHA: a code check answered `OTP_EXPIRED` for its stale code and `INVALID_OTP` for an unknown or a verified email; after F2-3 a second sign-up also left it without a live code | major | A missing and an expired code both answer `OTP_EXPIRED`; a second sign-up replaces only a stale code with a decoy (`email-codes.ts`, `issueDecoyCode` `keepLiveCode`); tested for the three kinds of address | Fixed |
| F2-15 | 2 | Audit (independent review) | Names still accepted the line and paragraph separators (U+2028, U+2029), which could fake a line in a Telegram card; Better Auth's `/verify-password` and `/forget-password` were not on the disabled list (the first is server-only in 1.7) | minor | Both separators refused in names; both paths disabled, with a test that walks every Better Auth endpoint and expects 404 for all but the seven the store uses | Fixed |
| F2-16 | 2 | Second review (another model) | Two password changes at once, from two sessions, could both write: the current password was checked before the transaction, and the second wrote after its session was ended by the first (also against a reset) | major | The change locks the customer, then checks its session and the current password inside the transaction; the email-change confirmation checks its session the same way; tested with two changes in parallel | Fixed |
| F2-17 | 2 | Second review | The email verification created its session after its transaction: a password reset landing between them left a session opened on the old password | major | The session is kept only if the verified password is still the account's (`proofStillHolds`), else deleted with no cookie; tested | Fixed |
| F2-18 | 2 | Second review | F2-14 again through the try counter: a code used up before a second sign-up kept its count for an unverified account only, so the next try answered `TOO_MANY_ATTEMPTS` there and `INVALID_OTP` elsewhere | major | Every failed code check answers `INVALID_OTP` with the same message whatever the reason (wrong, expired, used, voided; a first version still named the reason in the message, caught by the review); the store's text says "wrong or no longer valid: check it or ask for a new one"; tested | Fixed |
| F2-19 | 2 | Second review | The header's sign-out ignored a failed answer and went home anyway: on a shared device a 429 or 500 left the account open | major | Only a confirmed sign-out (or 401) leaves the page; otherwise an alert with a retry; E2E | Fixed |
| F2-20 | 2 | Second review | A failed email's SMTP text (which can name the recipient) went as is to `last_error`, the logs, Sentry and the Telegram alert | minor | `EmailSendError` keeps Nodemailer's code, the SMTP command and status only; tested with a rejected recipient | Fixed |
| F2-21 | 2 | Second review | A malformed `next` (`//[`) made `safeRedirect` throw after the sign-in had worked, leaving the form stuck | minor | A destination the browser cannot parse goes home; unit and E2E tests | Fixed |
| F2-22 | 2 | Second review | The links between sign-in, sign-up and the code page dropped `next`: from the cart a new customer ended on the home page | minor | `withNext` carries the checked destination on those links; E2E | Fixed |
| F2-23 | 2 | Second review | Signing out of this device (Better Auth's `/sign-out`) wrote no audit entry, unlike the other session endings (A2, C14) | minor | The sign-out hook ends the session and audits it in one transaction before Better Auth clears the cookie; tested | Fixed |
| F3-1 | 3 | 3.4 | Step 2 said "press the $10 preset", but with "ل.س" chosen the presets showed only their amount in pounds ("1,400 ل.س"); the owner did not find a "$10" button | minor | A pound preset also shows the dollars it stands for ("1,400 ل.س $10.00", `deposit-form.tsx`), and the step names the button by both; E2E | Fixed |
| F3-2 | 3 | Audit | The quote, deposit and reservation countdowns ran on the device's clock: a phone set minutes off showed the 15-minute lock still running after the server had ended it (the customer then meets `QUOTE_EXPIRED` and maybe a worse rate), or ended while it still held | major | Countdowns run on the server's clock, learned from the `Date` header of each `no-store` API answer (`lib/server-clock.ts`, `apiRequest`); the independent review caught that a first version also learned from cacheable answers, whose `Date` can be minutes old; unit tests | Fixed |
| F3-3 | 3 | Audit | After a rate change the panel read again only the rates, wallets and deposits: products, prices, orders, the dashboard and treasury kept SYP at the old rate until their next read | minor | A rate change reads every panel query again (`rates.queries.ts`, rule FX4) | Fixed |
| F3-4 | 3 | Second review (another model) | A requote, and a receipt refused for an expired quote, read the current rate through the shared pool while their transaction held a connection and the deposit's lock: 10 parallel requotes from one customer (the route allows 20 a minute) took every connection, each waiting on the others, and the whole API stopped answering | blocker | Rate reads inside a transaction use that transaction (`RatesService.current(db)`; requote, the expired-quote offer and the approval); a test sends 11 parallel requotes and hung before the fix; the independent review found the same pattern in the Telegram approval (the settings and the freeze read through the pool) and in the admin product list, both fixed | Fixed |
| F3-5 | 3 | Second review | The store's search kept its index for the tab's life: after a rate or price change, reopening the search showed the old SYP (and USD) until a full reload | minor | The index is read again once older than 30 seconds, the API's cache life (rule SR2); the old one shows until the new one arrives; E2E | Fixed |
| F3-6 | 3 | Second review | When another session changed the rate after the page loaded, a change the page judged under 5% was refused with `RATE_CONFIRMATION_REQUIRED`, but the confirmation field stayed hidden (computed from the old rate), so saving again failed the same way | minor | On a confirmation refusal the page reads the rate again and keeps what was typed, so the change percent and the confirmation field follow the new rate; the form clears itself after a save (it no longer remounts), and its step follows the current rate's until edited, so it never sends back a step another session replaced (caught by the independent review); E2E | Fixed |
| F3-7 | 3 | Second review | Twelve digits of pounds at a low rate (999,999,999,999 at 100) are worth more than the largest safe number of USD units: the conversion threw before the limit check, so the store form fell to its error screen and the API answered 500 (edge case 12 says the per-deposit limit stops them) | minor | Such an amount converts to null (`sypDepositUsdWithinRange`): creation answers the per-deposit limit, the store refuses with the limit's text, a requote or an approval answers `VALIDATION_FAILED`, and the panel's approval form says the amount is too large; unit and API tests | Fixed |
| F4-1 | 4 | 4.4 / 4.5 | A's Telegram card carried "⚠️ رقم هاتف مشترك" and only "رفض": TC1's phone is also another customer's, a precondition of the feature missed. The store behaved as designed (a flagged deposit is approved in the panel only, FL rules); flags are fixed at submission, so A keeps it | — (setup) | None: A approved in the panel with the flag acknowledged; TC1's phone changed to one no other customer has; the Telegram approval tested on a new deposit A2 (case 4.5b, a third real 700 ل.س, owner's approval) | Closed |
| F4-2 | 4 | 4.5 | Rotating the receipt a quarter turn in the panel's viewer swung the image out of its frame: its top was cut off and a horizontal scrollbar appeared; a zoomed receipt's start edge was out of reach of the scroll. The viewer rotated and zoomed with a CSS transform, which keeps the unturned layout box | minor | The image is laid out at its turned and zoomed size in a box that scrolls to every edge (`receipt-viewer.tsx`, `receipt-layout.ts`); unit test and E2E with a tall receipt | Fixed |
| F4-3 | 4 | Audit (independent review) | A transaction number compared only trimmed and upper-cased: the same transfer typed with Arabic-Indic digits (an Arabic keyboard in the bot), pasted with a direction or zero-width mark (copied from the right-to-left Sham Cash app), or with a space inside was a new claim, so one real transfer could be credited twice (deposit and deposit, or deposit and manual adjustment) | blocker | References are cleaned when typed (`cleanPaymentReference`: NFKC, format marks and spaces removed, Arabic-Indic and Persian digits to Latin) and normalized before every claim and lookup (`normalizePaymentReference`, `payment-references.ts`), whatever path they came by; the input refuses anything but printable ASCII once cleaned, and migration 0062 adds the same check to `payment_references` (a second review found that claims written before the fix keep their old spelling: on a table holding such a row the migration, and so the deploy, stops for the owner; production read 2026-10-16, read-only with the owner's approval: 5 claims, none with another spelling, so 0062 applies cleanly); tests for seven spellings on the deposit and adjustment paths and for the check | Fixed |
| F4-4 | 4 | Audit (independent review) | The panel's approval sent neither the credit on its button nor the receipt on screen: a rate change while the page was open credited another amount than the one confirmed (RV2), and a stale tab could approve a new receipt sent after a clearer-receipt request; the $100 re-authentication was decided before the lock | minor | The panel sends `expectedCreditUsdUnits` and `submittedAt`; inside the lock a different credit answers `DEPOSIT_CREDIT_CHANGED`, another receipt `DEPOSIT_STATE_CONFLICT`, and RV4 is checked again on the locked values; API test | Fixed |
| F4-5 | 4 | Audit (independent review) | Between a deposit's expiry and the expiry job (minutes, longer if the worker is down) the store showed the receipt form with "00:00", whose send button silently did nothing | minor | Past its expiry on the server's clock a pending Sham Cash deposit reads expired, with "إيداع جديد" (`deposit-page.tsx`); `useTimeLeft` reads the time at each render; E2E | Fixed |
| F4-6 | 4 | Audit (independent review) | A reused or similar receipt (FL1, FL2) did not say whether the other deposit was this customer's or another's, and a shared phone (FL5) gave only a count | minor | Each match reads "العميل نفسه" or links "عميل آخر" to that customer; FL5 links each other account (`deposit-flags.tsx`) | Fixed |
| F4-7 | 4 | Audit (independent review) | The credited and rejected emails named Sham Cash, but the same events serve USDT deposits | minor | Words that name neither method, the rejection naming both proofs (`email-templates.ts`); tested | Fixed |
| F4-8 | 4 | Audit (independent review) | The "الإيداعات" badge counted USDT deposits the worker was still checking, which need nothing from the admin | minor | `GET /api/admin/deposits/counts` adds `waiting` and `waitingFlagged` (Sham Cash submitted, USDT in review); the badge reads them; tested | Fixed |
| F4-9 | 4 | Second review (another model) | Two copies of a new image sent at the same instant by two customers each missed the other's uncommitted receipt, so neither carried "إيصال مكرّر" and both stayed open to Telegram approval (FL1, FL2, TC4) | major | Receipt submissions queue on one advisory lock taken after the deposit's, so each compares with every receipt before it (`deposits.service.ts`); API test with two parallel submissions | Fixed |
| F4-10 | 4 | Second review | A panel tab open on a first receipt could act on a second one sent after a clearer-receipt request: its rejection closed the new receipt, and after a refused approval the page kept showing the old image while the form sent the new submission | major | The rejection carries the submission its dialog opened on and is refused on another (`DEPOSIT_STATE_CONFLICT`); a newer submission on the page shows "وصل إيصال جديد بعد أن فتحت الصفحة" and starts the receipt viewer and the approval form again on it; API test and E2E | Fixed |
| F4-11 | 4 | Second review | A Telegram confirmation that had read the live link could still credit a deposit after the panel's unlink had returned | major | A bot update holds the link lock in shared mode from reading the link to its commit; unlink and linking take it exclusively, so they wait for updates in flight and none of the old chat acts after them (`telegram.service.ts`); API test with a confirmation held on the deposit's lock | Fixed |
| F4-12 | 4 | Second review | An older card's "اعتماد" or "رفض" (its edit not yet sent) opened a decision on the deposit's newer receipt, which the admin had not seen | minor | A decision button acts only on the deposit's card for its current submission (`cardShowsCurrent`), else answers "وصل إيصال أحدث لهذا الإيداع"; API test | Fixed |
| F4-13 | 4 | Second review (after F4-5) | Until the expiry job ran, "إيداع جديد" on an elapsed deposit led back to it: the options named it as open and a new deposit was refused with `DEPOSIT_ALREADY_PENDING` | minor | The expiry is shared (`expireDueDeposits` in `packages/db`, used by the worker's job) and runs for the customer inside a new deposit's creation; the options ignore an elapsed deposit; API test | Fixed |
| F4-14 | 4 | Second review | A card sent as text (its receipt unreadable) was edited with `editMessageCaption`, which Telegram refuses on text, so it kept its old content and buttons | minor | A refused caption edit ("no caption") is retried as a text edit (`deposit-card.job.ts`); worker test with a Bot API stub that enforces the message kind | Fixed |
| F4-15 | 4 | Second review | A submission decided before its first card job ran (the worker behind) never got a card | minor | Such a card is sent with its outcome and no buttons when the chat was linked at the submission; a chat linked later still gets no old cards (S05 edge cases 1 and 2); worker test | Fixed |
| F4-16 | 4 | Second review | A decision replayed with its key and another internal note answered success instead of `IDEMPOTENCY_KEY_REUSED` (RV9) | minor | The replay compares the note with the decision's audit entry (`AuditService.reasonOf`); API test for approval and rejection | Fixed |
| F5-1 | 5 | 5.6 | "الإيداعات المرشحة" read "لا إيداعات مرشحة." where step 5 expected C itself. The panel is right: candidates are the other reserved deposits a transfer may belong to (U11), so a deposit never lists itself; the step was wrong | minor | The step is corrected, and the empty text says "لا إيداعات أخرى مرشحة." so it reads as designed | Fixed |
| F5-2 | 5 | 5.6 (screenshot) | The USDT review's flag said "المعلن $4.0056، والمستلم $3.0056" under "المبلغ أو العملة المستلمة تختلف عن المعلنة": beside "المبلغ المعلن $4.00" in the facts, "المعلن" named the amount to send, and USDT amounts read as dollars with four decimals | minor | A USDT deposit's mismatch reads "المبلغ المستلم على الشبكة يختلف عن المبلغ المطلوب إرساله." and "المطلوب 4.0056 USDT، والمستلم 3.0056 USDT" (`deposit-flags.tsx`); E2E | Fixed |
| F5-3 | 5 | 5.4 | The BEP20 transfer was found by the scanner and credited before the owner could paste its TXID, so the searching and confirming pages were not seen on production | — | None: on BSC the scanner reads final blocks within seconds, which is the design (U12); the TXID states are covered by the worker tests and the store E2E screenshots | Accepted |
| F5-4 | 5 | 5.1 | The owner asked to change the receiving addresses from the panel, to upload a QR, or to style the QR for wallets per network | — | None: the addresses stay in the server environment (owner 2026-10-08, ADR 0018: a stolen admin session must not redirect deposits, and a crypto transfer cannot be reversed); an uploaded QR could encode another address than the text shown; a styled QR (network logo in the middle, high contrast) is a possible later store change, owner's call | Closed |
| F5-5 | 5 | 5.3 | The owner asked for automatic matching without the tail | — | None for V1: the alternatives are per-deposit addresses (sweeping fees and keys, ADR 0006), a payment processor (fees, availability for Syria unconfirmed), or a TXID claim alone (anyone can claim a public transfer); the tail stays, answered in chat | Closed |
| F5-6 | 5 | 5.1 (owner request) | The owner asked for a wallet-style QR, as the large exchanges show it | minor | The address QR is green-950 on white in both themes (error correction H) with the Vertex mark in its middle, framed by the network's color with "USDT" and the network named above it; a tap opens it larger with the address in groups of four (`usdt-qr.tsx`, theme tokens `network-tron` and `network-bnb`, `brand/identity.md` §6). Token and network logos are not used: §7 allows payment logos only as provided files, and BNB Chain asks for approval before its logo is used. E2E and screenshots | Fixed |
| F5-7 | 5 | External audit A1 (another model) | A TXID was claimed once per network only: a transfer approved in review under one network could be recorded again as a manual deposit under the other (or the reverse), crediting one real transfer twice | blocker | A TXID is one claim across both USDT networks: `claimPaymentReference`, `paymentReferenceOwner`, `txidClaimed` and `txidHolders` look across both, and migration 0063 adds `payment_references_usdt_txid_idx` (the TXID without its legacy `0X`, unique over the two networks) as the database's backstop; db tests (both orders, both stored forms, in parallel) and an API test (an approval then a manual deposit, and the reverse) | Fixed |
| F5-8 | 5 | External audit A2 | The BSC provider's key sits in its URL path (NodeReal), and Sentry's request breadcrumbs keep URL paths: the next worker error sent to Sentry could carry it; a fetch error on a URL with user info quoted the URL in the logs | blocker | Breadcrumbs keep only a URL's origin (the Telegram path with its token redacted, as before), dropping the query and user info (`scrub-breadcrumb.ts`); reader errors name only the error's code (`chain-http.ts`); a chain URL with user info is refused at boot (`env.ts`); worker tests | Fixed |
| F5-9 | 5 | External audit A3 | A burst of more than 1,000 TRON transfer events (dust spam) within the 2-minute overlap was read from its start again on every run: the scanner never progressed and TRC20 turned "delayed" for good | major | A run stopped at its page limit leaves a `:continue` cursor and the next run carries on from the last timestamp read with no overlap; the overlap applies again once caught up (`tron-reader.ts`); a test reads a 1,100-event burst to the end | Fixed |
| F5-10 | 5 | External audit A4 | An official USDT `Transfer` log missing its amount (or shortened) was dropped silently: a malformed reply read as "no USDT to the store" and could bounce a deposit, against U6 | major | An official USDT `Transfer` must have three topics and a 32-byte amount, else the read fails (`bad_response`) and is retried; another token's non-ERC-20 `Transfer` (an NFT) is still skipped (`tron-reader.ts`, `bsc-reader.ts`); tests per missing part | Fixed |
| F5-11 | 5 | External audit A5 | Between a USDT deposit's expiry and the expiry job (up to 5 minutes) the page still showed the amount, the QR and the TXID field, inviting a transfer too late to match | major | The F4-5 overdue display covers USDT: the page reads expired with the late-transfer help and keeps reading the deposit, so a transfer sent in time still shows credited (`deposit-page.tsx`); E2E | Fixed |
| F5-12 | 5 | External audit A6 | A `wrong_network` review's Telegram card named the deposit's network and linked the TXID to the wrong explorer | minor | The card names the network the transfer is on ("وصل على … والإيداع على …") and links that network's explorer (`messages.ts`, `deposit-card.job.ts`); worker test both ways | Fixed |
| F5-13 | 5 | External audit A7 | The new QR had no quiet zone of its own (`marginSize` 0): the label and frame edge sat closer than the four modules the standard asks | minor | Four modules of white inside the QR itself, the mark 18% of the whole (about 5% of the code's area) (`usdt-qr.tsx`); screenshots. A real wallet camera scan on both networks is still to be done on production | Fixed |
| F5-14 | 5 | External audit A8 | The admin E2E listed the reviewed deposit as its own candidate, which the API never returns (F5-1) | minor | The fixture lists another customer's deposit; the test checks the deposit is not its own candidate and the empty text "لا إيداعات أخرى مرشحة." | Fixed |

Severity: **blocker** (money, security or a broken flow; fixed before the feature is accepted), **major** (wrong behaviour with a workaround; fixed before the pilot), **minor** (text, layout; may become a follow-up).

---

## Feature 1 — Admin access, 2FA and audit log (F02)

**What it covers:** the single admin account (ADR 0016): sign-in with mandatory TOTP, backup codes, re-authentication for sensitive actions, idle and absolute session expiry, own sessions, password change, separation from customer sessions, and the append-only audit log (S01 D1–D8, A1–A4).

**Before you start**

- A desktop browser (PC) signed in to the panel, a second browser or a private window, and your phone.
- Your password manager open: case 1.9 changes the admin password and case 1.10 replaces the backup codes. Save the new values there at once.
- About 75 minutes in total, of which 31 are waiting in case 1.7 (do other cases meanwhile in another browser).

**Not tested on production (by design):** `admin:create`, `admin:reset-password` and `admin:reset-two-factor` run on the server only and are covered by the automated tests (S01 acceptance 7–8). They are run on production only if a real recovery is ever needed.

### 1.1 Sign-in requires the password, then TOTP

1. In the panel, open the account menu (top corner) and sign out.
2. On `/login` enter the admin email and password, press "تسجيل الدخول".
3. Expected: a second step asks for the 6-digit code from the authenticator app; the panel is not reachable yet (open `https://digital-admin.vertexmedia.pro/` in the same tab: you stay on the code step or return to `/login`).
4. Enter the current code.
5. Expected: the dashboard opens.

Result: ✅ (2026-10-15)

### 1.2 Wrong password and wrong code are refused (one try each)

1. Sign out. Enter the right email with a wrong password, once.
2. Expected: a general error that does not say whether the email exists; no code step.
3. Enter an email that has no admin account (for example `test@vertexmedia.pro`) with any password, once.
4. Expected: the same general error as step 2, word for word.
5. Sign in with the right password; at the code step enter a wrong code, once.
6. Expected: "the code is wrong" error; you stay on the code step. Enter the right code: the dashboard opens.

Result: ✅ (2026-10-15)

### 1.3 Signing in with a backup code

1. Sign out. Sign in with the password; at the code step press "استخدم رمزًا احتياطيًا" and enter one of your saved backup codes.
2. Expected: the dashboard opens.
3. Mark that backup code as used in your password manager (each code works once).
4. Sign out and try the same backup code again.
5. Expected: refused with "الرمز الاحتياطي غير صحيح أو استُخدم من قبل.". Sign in with the authenticator code.

Result: ✅ (2026-10-15)

### 1.4 The panel and its API refuse anyone not signed in

1. In a private window open `https://digital-admin.vertexmedia.pro/audit`.
2. Expected: redirected to `/login`; after signing in (password + code) you land on `/audit`, not the dashboard. Close the private window afterwards.
3. In a private window open `https://digital-admin.vertexmedia.pro/api/admin/audit`.
4. Expected: an error response (401), no audit data.
5. Open `https://digital.vertexmedia.pro/api/admin/audit` (the store host).
6. Expected: 404: admin routes do not exist on the store host.

Result: ✅ (2026-10-15)

### 1.5 A customer session cannot use the panel

1. In one browser sign in to the store as TC1 (`https://digital.vertexmedia.pro/sign-in`).
2. In the same browser open `https://digital-admin.vertexmedia.pro/` and `https://digital-admin.vertexmedia.pro/api/admin/audit`.
3. Expected: the panel shows `/login`; the API answers 401. The customer's store session is untouched (reload the store: still signed in).

Result: ✅ (2026-10-15)

### 1.6 Re-authentication for sensitive actions

Use a harmless sensitive save: "إعدادات الدعم" (`/settings/support`), saving the same Telegram link unchanged.

1. Sign out and sign in again (this clears any earlier re-authentication).
2. Open `/settings/support` and press "حفظ" without changing the link.
3. Expected: the "تأكيد هويتك" dialog asks for the password and the authenticator code.
4. Enter a wrong code once. Expected: an error; the dialog stays; nothing is saved.
5. Look for a backup-code option in the dialog. Expected: none; it takes only the 6-digit authenticator code (backup codes are not accepted for re-authentication, S01 D5).
6. Enter the password and the right authenticator code. Expected: the dialog closes and the save goes through on its own ("حُفظ الرابط.") without pressing "حفظ" again.
7. Within 5 minutes press "حفظ" again. Expected: saved at once, no dialog.
8. Wait 6 minutes (do 1.8 meanwhile), press "حفظ" again. Expected: the dialog appears again.
9. Press "إلغاء" or close the dialog. Expected: nothing is saved and no error remains on the page.

Result: ✅ (2026-10-15)

### 1.7 Idle timeout after 30 minutes

1. In a separate browser (not the one you keep working in), sign in to the panel and open `/orders`.
2. Do not touch that browser for 31 minutes (an open page polling on its own does not count as activity).
3. Click any link in the sidebar, for example "الكتالوج".
4. Expected: `/login` with the notice "انتهت الجلسة بعد 30 دقيقة دون نشاط…"; after signing in you return to the page you clicked.

Result: ✅ (2026-10-15)

### 1.8 Own sessions and signing one out

1. Sign in to the panel on your phone as well (password + code).
2. On the PC open "حسابي" (`/account`), sessions section.
3. Expected: at least two sessions (PC and phone), each with its browser or system and time; the current one is marked.
4. Sign out the phone's session from the PC.
5. Expected: on the phone, the next action (tap any link) goes to `/login`. The PC session is untouched.

Result: ✅ (2026-10-15)

### 1.9 Changing the admin password

Have the password manager ready; save the new password before pressing the button.

1. Sign in on the phone again, so two sessions exist.
2. On the PC, "حسابي" → change password. Enter the current password and a new password of 11 characters.
3. Expected: refused (at least 12 characters).
4. Try a common password such as `password1234`. Expected: refused as too common.
5. Try your email address as the new password. Expected: refused.
6. Enter the current password wrong once, with a valid new password. Expected: refused; the password does not change.
7. Enter the current password and a valid new password (12+ characters, saved in the password manager first).
8. Expected: success. The phone session is signed out (next tap goes to `/login`); the PC session stays.
9. Sign out on the PC and sign in with the new password and the authenticator code. Expected: works. The old password is refused (try it once).

Result: ✅ (2026-10-15)

### 1.10 Regenerating backup codes

1. "حسابي" → regenerate backup codes. Enter a wrong password once. Expected: refused, no codes shown.
2. Enter the right password. Expected: new codes shown once, with copy or download.
3. Save them in the password manager, replacing the old list.
4. Reload the page. Expected: the codes are not shown again.
5. Sign out, sign in with the password and one of the **old** backup codes. Expected: refused.
6. Sign in with one of the **new** codes. Expected: works; mark it used.

Result: ✅ (2026-10-15)

### 1.11 The audit log records every admin action

1. Open "سجل التدقيق" (`/audit`).
2. Expected: newest first, each row with time (your time zone), actor, action label in Arabic, entity, channel.
3. Find this session's entries: sign-ins (`admin.signed_in`), the password change, the backup codes regenerated, the session sign-out, the support link saves from 1.6.
4. Find the setup done on 2026-10-15: exchange rate set (140), deposit settings saved, banners created and enabled, FAQ published, the support link, the manual route on 60 UC, and the three test customers created.
5. Expected: each one is there exactly once per action, with the admin as actor.
6. Open the rate entry's detail sheet. Expected: labelled before and after values (no rate → 140, step 1), IP and browser.
7. Open the password-change and backup-code entries. Expected: no password, code, hash or token anywhere in the details.

Result: ✅ (2026-10-15)

### 1.12 Audit log filters and paging

1. Filter by actor kind "admin". Expected: only admin rows.
2. Filter by actor kind "customer" and TC1's id (from `/customers`). Expected: only TC1's account actions (for example its sign-up or creation, profile changes); the customer's name shows as actor.
3. Filter by action (for example the rate change). Expected: only that action.
4. Filter by entity type and id (copy an id from a row). Expected: only that entity's rows.
5. Filter by a date range of today only, then yesterday only. Expected: rows of that range only.
6. Combine filters that match nothing. Expected: "no entries match these filters" empty state.
7. Clear filters and press "load more" until the end. Expected: older rows load in order without duplicates.

Result: ✅ (2026-10-15)

### 1.13 The audit log cannot be changed

1. In `/audit` and its detail sheet, look for any edit, delete or hide control.
2. Expected: none. Entries are read-only (append-only by database trigger and grants; covered by the automated tests).

Result: ✅ (2026-10-15)

### 1.14 Panel quality on desktop and phone

1. On the PC, switch between the light and dark themes (top bar). Expected: every screen used above is readable in both; RTL layout, Latin digits.
2. On the phone, open `/audit` and `/account`. Expected: the sidebar becomes a menu button, tables fit or scroll inside their card, no horizontal page scroll, dialogs fit the screen.

Result: ✅ (2026-10-15)

### 1.15 Absolute session limit of 12 hours

The session is never extended by use (`disableSessionRefresh`, S01 D4), so its end is fixed at sign-in and shows as the session cookie's expiry. No 12-hour wait is needed.

1. Sign out and sign in again on the PC (Chrome). Note the time.
2. Press F12 → "Application" → "Cookies" → `https://digital-admin.vertexmedia.pro`. Find the session cookie (its name contains `session_token`).
3. Expected: its "Expires" is your sign-in time plus 12 hours (shown in UTC: Damascus is UTC+3).
4. Use the panel for a few minutes (open pages, save something harmless), then reload the cookie list.
5. Expected: "Expires" has not moved.

Result: ✅ (2026-10-15). Read from the panel's own sessions list (`GET /api/admin/me/sessions`): each session's `expiresAt` is its `createdAt` plus exactly 12 hours, and the current session, used for about two hours, was not extended.

### Feature 1 sign-off

| Item | Value |
|---|---|
| Cases passed | 15 of 15 |
| Findings | F1-1 to F1-4 (code audit, minor), F1-5 to F1-10 (second review: 1 blocker, 3 major, 2 minor); all fixed |
| Accepted by the owner on | 2026-10-15 |
| PR | — |

---

## Feature 2 — Customer accounts (F01)

**What it covers:** the customer's account on the store (S01 C1–C17, T1–T4, E1–E5): registration closed by default, test customers created by the admin, sign-up with an email code, sign-in with its limits, forgot password, profile, password and email changes, the sessions list, the security emails, and the store screens on phone and desktop.

**How to read a case:** each case starts with **What this checks**, one plain sentence on why it matters. Then do the numbered steps in order. A line starting with "Expected" is what you must see; if you see something else, mark the case ❌ and write what you saw.

**Before you start**

- Four email inboxes you can read. The simplest way: your own mailbox with a `+` alias per account (for example `yourname+tc1@…`, `yourname+tc2@…`, `yourname+tc3@…`, `yourname+su@…`). Mail sent to an alias arrives in your normal inbox. Also a fifth alias (`+su2`) for case 2.12.
- The panel open on the PC (signed in), the store open in a second browser or a private window on the PC, and your phone.
- Your password manager: every case that sets a password saves it there at once.
- About 70 minutes. Codes are valid 10 minutes, and one address may ask for a new code once a minute and 5 times an hour: never press "send code" repeatedly.
- **SU** is a temporary real sign-up (not a test customer) used only in this feature; case 2.15 archives it at the end, so it never shows in reports.

**Not tested here:** freezing, limits and customer search (feature 16), notification preferences (feature 19), and the registration switch's history (feature 21).

### 2.1 Registration is closed by default

**What this checks:** before the pilot, strangers cannot create accounts.

1. In the store browser (signed out), open `https://digital.vertexmedia.pro/`.
2. Expected: the header shows "تسجيل الدخول" and **no** "إنشاء حساب" link.
3. Open `https://digital.vertexmedia.pro/sign-up`.
4. Expected: the calm message "التسجيل يفتح قريبًا", and no form.
5. In the panel open "المفاتيح" (`/settings/switches`). Expected: "التسجيل" shows "مغلق".

Result: ✅ 2026-10-15

### 2.2 Test customers from the panel (TC1, TC2, TC3)

**What this checks:** the admin can make verified accounts for testing while registration is closed, and their passwords are shown only once.

1. In the panel open "عملاء الاختبار" (`/test-customers`). Press "إضافة عميل اختبار".
2. Enter a name, the `+tc1` address and a Syrian mobile in the local form (`09…`). Press "إنشاء الحساب".
3. Expected: a dialog shows the password once with a copy button and the warning "لن تظهر كلمة المرور هذه مرة أخرى". Copy it to the password manager, press "تم".
4. Expected: the row shows the phone as `+963 9…` (normalized), and no email arrives at `+tc1` (test customers get no welcome email).
5. Repeat for TC2 (`+tc2`) and TC3 (`+tc3`).
6. Try to add a fourth one with the `+tc1` address again. Expected: refused with "email already used"; nothing is created.
7. In "سجل التدقيق" filter the action "إنشاء عميل اختبار". Expected: three entries, and no password anywhere in their details.
8. In the store browser sign in as TC1 with its password. Expected: signed in at once (no code step), the header shows TC1's initial.

Result: ✅ 2026-10-15. The copy button answered "تعذّر النسخ" in the in-app test browser, which denies the clipboard (F2-1); the password was copied by hand.

### 2.3 Sign-up while registration is open (SU)

**What this checks:** a new customer can create an account with name, email, password and phone, protected by the browser check (ALTCHA), and no session exists before the email is proven.

Do 2.3 to 2.5 in one sitting: registration stays open only for those minutes.

1. In the panel, "المفاتيح" → "التسجيل" → open it. Confirm the dialog (the re-authentication dialog may ask for your password and code).
2. In the store browser, signed out, reload the home page. Expected: "إنشاء حساب" is now in the header.
3. Open "إنشاء حساب". Leave every field empty and press "إنشاء الحساب". Expected: an error under each field; the first one gets the focus.
4. Enter a name, the `+su` address, the password `qwerty123` (a common password). Expected: refused as too common.
5. Enter a strong password, and a phone in the local form `09…`. Press "إنشاء الحساب".
6. Expected: you go to the code page "تأكيد البريد الإلكتروني", which shows the `+su` address. Within a minute an Arabic email with a 6-digit code arrives.
7. Do **not** enter the code yet: go to 2.4.

Result: ✅ 2026-10-15, re-run after the deploy of aba5ee3 with a new address (SU3): `qwerty123` refused, a second sign-up with the same address sent the attempt notice and no new code (F2-3). First run ❌: `password123` accepted (F2-2, accepted) and the code voided by a second sign-up (F2-3). Second re-run after the deploy of a2bfdb7 (fixes F2-8 to F2-23), with a fresh address: ✅.

### 2.4 An address that already has an account reveals nothing

**What this checks:** nobody can find out whether an email is registered by trying to sign up with it (account enumeration).

1. In a private window, open "إنشاء حساب" and sign up with TC2's address (`+tc2`), any name, a strong password and a phone.
2. Expected: exactly the same code page as in 2.3: nothing says the address is taken.
3. Expected: the `+tc2` inbox receives "someone tried to sign up with your email" (no code inside). TC2's password still works (nothing changed).
4. Close the private window.

Result: ✅ 2026-10-15

### 2.5 Email code: wrong code, resend, then success

**What this checks:** the 6-digit code proves the address, a new code voids the old one, and the first session is created only by a right code.

1. Back on SU's code page, enter a wrong code (any 6 digits), once. Expected: "wrong code"; you stay on the page.
2. Expected: "أرسل رمزًا جديدًا" counts down 60 seconds before it can be pressed. When it opens, press it. Expected: "أرسلنا رمزًا جديدًا. الرمز السابق لم يعد صالحًا." and a second email.
3. Enter the **first** code. Expected: refused (the old code is void).
4. Copy the second code from the email and paste it into the first box. Expected: all six digits fill at once.
5. Submit. Expected: signed in as SU, back on the home page.
6. Expected: **no** "new sign-in" email for this session (the code page's sign-in does not send one).
7. In the panel, "المفاتيح" → "التسجيل" → close it again. In the store browser sign out, reload: "إنشاء حساب" is gone again.

Result: ✅ 2026-10-15, re-run after the deploy of aba5ee3: the six-slot field filled from one paste (F2-4); after a reload the page asked for the password and the code with it signed in (F2-7). Second re-run after the deploy of a2bfdb7: ✅.

### 2.6 Sign-in, its errors and the new sign-in email

**What this checks:** sign-in works, errors never say whether the email exists, and every new sign-in is reported to the customer by email.

1. In the store, "تسجيل الدخول": SU's address with a wrong password, once. Expected: a general error ("email or password is wrong").
2. An address that has no account (`+nobody`) with any password, once. Expected: the same error, word for word.
3. Sign in as SU with the right password. Expected: signed in.
4. Expected: the `+su` inbox gets a "new sign-in" email with the time, the browser and system, and the IP address.
5. Open `https://digital.vertexmedia.pro/account` signed out (private window). Expected: the sign-in page; after signing in you land on `/account`.

Result: ✅ 2026-10-15

### 2.7 The browser check after 3 failed sign-ins

**What this checks:** a password-guessing script is slowed down: after 3 failures on one email, sign-in needs the ALTCHA check.

Wait 10 minutes after any earlier failed sign-in before this case, to stay far from the server's ban threshold.

1. Signed out, enter TC3's address with a wrong password three times.
2. Expected: before or at the fourth try the store shows the browser check ("جارٍ التحقق من المتصفح…"), which solves itself in a few seconds.
3. Sign in with TC3's right password. Expected: signed in. Sign out.

Result: ✅ 2026-10-15

### 2.8 Forgot password

**What this checks:** a customer who forgot the password gets back in by email code, every other device is signed out, and the page never tells whether the email is registered.

1. Sign in as TC1 on the phone (keep it signed in).
2. On the PC store (signed out): "نسيت كلمة المرور؟" → enter the `+nobody` address → "أرسل الرمز". Expected: the code step with "إن كان لهذا البريد حساب فقد أرسلنا إليه رمزًا"; no email arrives anywhere. Press "استخدم بريدًا آخر".
3. Enter TC1's address → "أرسل الرمز". Expected: the same code step, and an email with a code.
4. Enter the code and a new strong password (save it). Press "تعيين كلمة المرور".
5. Expected: the sign-in page with "تغيّرت كلمة المرور. سجّل الدخول بكلمة المرور الجديدة."; you are **not** signed in yet.
6. On the phone, tap any link. Expected: TC1 is signed out there.
7. On the PC sign in with the old password: refused. With the new one: signed in.

Result: ✅ 2026-10-15

### 2.9 Profile: name and phone

**What this checks:** the customer can fix their name and phone, wrong values are refused, and every change is recorded with before and after.

1. As TC1 open "حسابي" (`/account`). Expected: name, email, phone and "عضو منذ …".
2. "تعديل": clear the name and type one letter. Press "حفظ". Expected: refused with a field error.
3. Enter a phone like `0912` (too short). Expected: refused.
4. Enter a correct new name and phone `+963 9…` with spaces. Press "حفظ". Expected: "حُفظت التغييرات.", the phone shown normalized.
5. In the panel's audit log filter the action "تعديل بيانات العميل". Expected: an entry with "customer" as actor and the before and after values.

Result: ✅ 2026-10-15

### 2.10 Change password

**What this checks:** changing the password needs the current one, signs out every other device, and the customer is told by email.

1. Sign in as TC1 on the phone too.
2. On the PC, "حسابي" → "كلمة المرور": a wrong current password, once. Expected: "current password is wrong" under the field.
3. The right current password and a new strong one (save it). Expected: "تغيّرت كلمة المرور، وسُجّل خروجك من الأجهزة الأخرى."; the PC stays signed in.
4. On the phone, tap any link. Expected: signed out.
5. Expected: the `+tc1` inbox gets "your password was changed" (no password inside).

Result: ✅ 2026-10-15; re-run 2026-10-15 after the deploy of a2bfdb7 (fixes F2-8 to F2-23): ✅

### 2.11 Sessions list and signing out

**What this checks:** the customer sees every signed-in device and can end one or all of them, for example after losing a phone.

1. Sign TC1 in on the phone again, so TC1 has the PC and the phone.
2. On the PC, "حسابي" → "الأجهزة المسجّل دخولها". Expected: two rows with browser and system, IP and last activity; the PC row has "هذا الجهاز".
3. Press "تسجيل الخروج" on the phone's row. Expected: the row goes; on the phone the next tap signs out.
4. Sign in on the phone once more. On the PC press "تسجيل الخروج من كل الأجهزة" → confirm.
5. Expected: the PC goes to the sign-in page with "سُجّل خروجك من كل الأجهزة"; the phone is signed out at its next tap.

Result: ✅ 2026-10-15; re-run 2026-10-15 after the deploy of a2bfdb7 (fixes F2-8 to F2-23): ✅

### 2.12 Change email

**What this checks:** an account cannot be stolen by changing its email: it needs the password and a code sent to the new address, the old address is told, and other devices are signed out.

1. Sign SU in on the PC and the phone.
2. On the PC, "حسابي" → email "تغيير". Enter TC3's address (`+tc3`) and SU's password. Expected: the same "code sent" step as for a free address, no code arrives at `+tc3`, and `+tc3` gets "someone tried to sign up with your email" (TC3, not TC2: that notice goes to one address at most once an hour). Go back.
3. Enter the new address `+su2` with a **wrong** password, once. Expected: refused.
4. Enter `+su2` with the right password. Expected: a code arrives at `+su2` (not at `+su`).
5. Enter the code. Expected: "تغيّر بريدك الإلكتروني، وأرسلنا إشعارًا إلى بريدك السابق."; the profile shows `+su2`.
6. Expected: `+su` (the old address) gets "your email was changed"; the phone is signed out at its next tap.
7. Sign out, then sign in with `+su2`. Expected: works; `+su` no longer signs in.

Result: ✅ 2026-10-15; re-run 2026-10-15 after the deploy of a2bfdb7 (fixes F2-8 to F2-23): ✅

### 2.13 The admin resets a test customer's password

**What this checks:** the admin can reset a test account (never a real one) and that signs it out everywhere.

1. Sign TC2 in on the phone.
2. In the panel "عملاء الاختبار" → TC2's row → "إعادة تعيين كلمة المرور" → confirm.
3. Expected: the new password is shown once (save it); an audit entry "إعادة تعيين كلمة مرور عميل اختبار" without the password.
4. On the phone, tap any link. Expected: TC2 is signed out; the old password is refused; the new one works.
5. Expected: SU does **not** appear on the test-customers page (it is a real sign-up).

Result: ✅ 2026-10-15

### 2.14 Emails and screens quality

**What this checks:** what the customer sees looks professional and trustworthy on a phone and on a computer.

1. Look at the emails from this feature (code, attempt notice, new sign-in, password changed, email changed). Expected: Arabic, right to left, the store's sender name, a plain readable layout, no link carrying a token, no password; check that none landed in spam (if one did, note which).
2. On the phone, open sign-in, forgot password, the code page and "حسابي" in the light and dark themes. Expected: readable, no horizontal scroll, the code field opens the number keyboard, Latin digits everywhere.
3. On the PC, the same pages at full width. Expected: the forms stay centred and readable.

Result: ✅ 2026-10-15, re-run after the deploy of aba5ee3: the emails carry the logo and the brand colours with the Damascus month names, none in spam (F2-5, F2-6); the account screens checked by Claude on production at phone and desktop width. First run: the owner asked for the logo and the brand colours.

### 2.15 Clean-up: archive SU

**What this checks:** an archived account cannot sign in and its open sessions stop at once; this also keeps SU out of reports.

1. Sign SU in on the phone.
2. In the panel open "العملاء", find SU (by `+su2`) → "إجراءات العميل" → "أرشفة", with the reason "temporary sign-up test". Confirm (re-authentication if asked).
3. Expected: on the phone, the next tap signs SU out; signing in again is refused with the general error.

Result: ✅ 2026-10-15; SU3 of the re-run archived the same way.

### Feature 2 sign-off

| Item | Value |
|---|---|
| Cases passed | 15 of 15 (2.3, 2.5 and 2.14 after the fixes, deployed as aba5ee3; 2.3, 2.5, 2.10, 2.11 and 2.12 again after the audit fixes, deployed as a2bfdb7) |
| Findings | F2-1 (not a bug), F2-2 (accepted: the owner keeps the common-password list), F2-3 to F2-23 (fixed) |
| Accepted by the owner on | 2026-10-15 |
| PR | #104 (fixes F2-16 to F2-23), and this record |

---

## Feature 3 — Exchange rate and SYP display (F04)

**What it covers:** the admin's USD→SYP rate (S03 FX1–FX9): setting it with history, re-authentication and a typed confirmation above a 5% change, the display step and its bounds (FX3, S07 P9), the SYP value shown next to USD in the store and the panel, and the 15-minute rate lock on a SYP deposit quote with its countdown and the new-rate offer after it ends (FX5, SC9). No money moves in this feature: the one SYP deposit it opens is cancelled before any receipt is accepted.

**How to read a case:** as in feature 2: **What this checks** first, then the numbered steps; a line starting with "Expected" is what you must see.

**Before you start**

- The panel open on the PC (signed in), the store open as TC1 in a second browser, and your phone.
- In the panel, "إعدادات الإيداع" (`/settings/deposits`): Sham Cash in ل.س is enabled. If not, enable it for this feature (re-authentication) and note it here; the deposit itself is feature 4.
- Note the current rate and step from "سعر الصرف" (`/rates`) before you start (expected: 140 and the step set on 2026-10-15). Cases 3.7 and 3.8 put both back.
- A harmless image on the PC for case 3.6 (any screenshot, **not** a real receipt): the server refuses it before reading it, so it is never stored.
- About 45 minutes, of which 15 are waiting in case 3.6. Re-authentication lasts 5 minutes: each case that saves a rate does its saves in one sitting.

**Worked numbers used below** (rate 140): 2,000 ل.س is $14.2857, credited as **$14.28** (always rounded down to the cent, FX6). At 145 the same 2,000 ل.س is **$13.79**. A store price in SYP is the USD price × the rate, rounded **up** to the next multiple of the step (for example $1.10 × 140 = 154 → 155 with a step of 5).

**Not tested on production (by design):** the stale-rate banner after 48 hours without a change (FX7) and the state with no rate at all (FX8): the first needs two idle days, the second an empty rate history, which production can never return to (rates are append-only). Both are covered by the automated tests (S03 tests, admin E2E). The rate each money record stores is checked where the records are made: deposits in feature 4, orders in feature 11, reports in feature 22. The wallet's SYP value rounding down needs a balance and is checked in feature 6.

### 3.1 The current rate and its history

**What this checks:** the admin sees at a glance which rate the store uses, since when, and every earlier rate with who set it.

1. In the panel open "سعر الصرف" (`/rates`).
2. Expected: "السعر الحالي" shows "140 ل.س لكل دولار", the display step ("خطوة العرض") in ل.س, and "منذ" with the date and time it was set (your time zone, Damascus month names).
3. Expected: "سجل الأسعار" lists at least the rate set on 2026-10-15, with time, rate, step, change and "بواسطة" the admin. The first rate ever has no change percent.
4. Expected: no stale-rate banner at the top of any panel page (the rate is less than 48 hours old).

Result: ✅ 2026-10-15

### 3.2 Wrong values are refused before anything is saved

**What this checks:** a typo cannot reach the store: the form refuses rates and steps that make no sense.

1. In "تغيير السعر", enter each of these as the rate, one at a time, and press "حفظ السعر": `0`, `abc`, `140.12345` (5 decimals), `١٤٠` (Arabic digits).
2. Expected: each is refused under the field with "أدخل سعرًا أكبر من صفر بأرقام لاتينية، حتى 4 منازل عشرية."; no re-authentication dialog, nothing in the history.
3. Enter a valid rate (`140`) and the step `0`, then `51`, then `2.5`.
4. Expected: each is refused under the step with "أدخل عددًا صحيحًا من الليرات بين 1 و50."; nothing saved.
5. Empty the form (reload the page).

Result: ✅ 2026-10-15

### 3.3 SYP next to USD in the store and the panel

**What this checks:** the customer always sees the price in the pounds they pay with, computed from today's rate and rounded to a clean number.

1. In the store as TC1 open "المحفظة" (`/wallet`).
2. Expected: under the balance, "≈ … ل.س حسب سعر اليوم 140".
3. Open a game page (for example PUBG Mobile). Pick two packs and write down their USD price and SYP line ("≈ … ل.س").
4. Expected: each SYP value is USD × 140, rounded **up** to the next multiple of the step (never down, never with a remainder).
5. Open the search (top bar), type the game's name. Expected: the same SYP values as on the game page.
6. Choose one pack and look at its buy box (do **not** buy). Expected: the total shows the same SYP value; with quantity 2 (if the pack allows it) the SYP total follows.
7. In the panel open "المحافظ" → TC1's wallet (`/wallets/<id>`). Expected: the header shows the SYP value at 140.
8. Expected everywhere: Latin digits, "ل.س" after the number, the number not broken across the line.

Result: ✅ 2026-10-15

### 3.4 A SYP deposit quote locks the rate for 15 minutes

**What this checks:** the customer sees exactly how many dollars their pounds will give before they send anything, and that number is held for 15 minutes.

1. Note the time. In the store as TC1, "المحفظة" → "إيداع" → "شام كاش".
2. Choose "ل.س". Under the amount field each preset ($5, $10, $25, $50) shows its pounds and the dollars it stands for: press "1,400 ل.س $10.00". Expected: the amount becomes 1,400 (USD 10 × 140, rounded up to the step).
3. Replace the amount with `2000`. Expected: "ستحصل على $14.28" (not $14.29), "بسعر 140 ل.س للدولار" and "السعر مقفل 15 دقيقة بعد المتابعة".
4. Press "متابعة" (the browser check solves itself).
5. Expected: the deposit page shows the amount 2,000 ل.س, "يُضاف إلى محفظتك $14.28", and "السعر 140 ل.س للدولار مقفل لمدة" with a countdown starting near 15:00 and going down.
6. Reload the page. Expected: the countdown continues from the right time (it does not restart at 15:00).
7. Do **not** add a receipt. Go to 3.5 straight away, keeping this page open.

Result: ✅ 2026-10-15. Step 2 named a "$10" button the form did not show: with "ل.س" chosen each preset read only its pounds (F3-1, fixed: the preset now also shows the dollars).

### 3.5 A small rate change: no confirmation, open quotes keep their rate

**What this checks:** a normal daily change is quick to make, applies at once to every price, and never changes what a customer was already promised.

1. In the panel, "سعر الصرف" → rate `145`, keep the step. Expected, before saving: "التغيير عن السعر الحالي: +3.58%" in normal colour, and **no** "أعد كتابة السعر" field.
2. Press "حفظ السعر". Expected: the re-authentication dialog (password and authenticator code); after it, "حُفظ السعر الجديد، ويُطبَّق فورًا على العرض والإيداعات الجديدة.", the current rate reads 145, and the history has a new top row: 145, +3.58%, the admin.
3. In the store, reload TC1's deposit page from 3.4. Expected: still "السعر 140 ل.س للدولار مقفل لمدة …" and "$14.28": the lock holds.
4. Reload "المحفظة" and the game page from 3.3. Expected: "حسب سعر اليوم 145", and each pack's SYP value is now USD × 145 rounded up to the step.

Result: ✅ 2026-10-15

### 3.6 When the lock ends, the customer must accept the new rate

**What this checks:** after 15 minutes nobody can send a receipt at an old rate: the store shows the new rate and the new dollars and waits for the customer's yes.

Meanwhile do 3.9.

1. On TC1's deposit page wait until the countdown reaches zero (15 minutes after "متابعة" in 3.4). Expected: "انتهت مدة السعر".
2. Add the harmless image (paste or the file picker) and press "أرسل الإيصال".
3. Expected: the sheet "تغيّر سعر الصرف" with "السعر الجديد (ل.س للدولار)" 145 and "يُضاف إلى محفظتك" $13.79, and the button "أوافق وأرسل".
4. Do **not** accept: close the sheet (the close button or Esc).
5. Expected: the deposit is still waiting for a receipt; nothing was sent. In the panel, "الإيداعات" → "قيد المراجعة" does not list it, and the badge did not change.
6. On the deposit page press "إلغاء الإيداع" and confirm. Expected: the cancelled state with "إيداع جديد"; "إيداعاتي" lists it as cancelled.

Result: ✅ 2026-10-15

### 3.7 A large change needs the rate typed twice

**What this checks:** a slip of the finger (1,450 for 145) cannot go live: above 5% the admin must type the new rate again, by hand.

Do 3.7 and 3.8 in one sitting (re-authentication lasts 5 minutes).

1. In "سعر الصرف" enter the rate `160`. Expected: "التغيير عن السعر الحالي: +10.35%" in the warning colour, and the field "أعد كتابة السعر" with "التغيير أكبر من 5%…".
2. Leave the confirmation empty, press "حفظ السعر". Expected: "أعد كتابة السعر الجديد للتأكيد." under it; nothing saved.
3. Copy `160` from the rate field and try to paste it into the confirmation. Expected: the paste does nothing.
4. Type `161` in the confirmation, press "حفظ السعر" (re-authenticate if asked). Expected: refused under the confirmation (the two rates do not match); the current rate is still 145.
5. Type `160`, press "حفظ السعر". Expected: saved; the history's top row is 160, +10.35%.
6. Put the rate back: `140`, confirmation `140`. Expected: -12.50% with the confirmation field; saved; current rate 140.

Result: ✅ 2026-10-15

### 3.8 The display step and its limit

**What this checks:** the step keeps SYP prices clean, but can never push the cheapest pack's price up by more than 2% (ADR 0003).

1. Keep the rate `140`, set the step to `50`, press "حفظ السعر".
2. Expected: refused under the step with "هذه الخطوة تزيد سعر أرخص باقة متوفرة بأكثر من 2%. أكبر خطوة مسموحة الآن … ل.س."; write down the largest step it names. Nothing saved.
3. Set the step to `1`. Expected: saved (a step change alone needs no confirmation); a new history row with rate 140 and step 1 ل.س, change 0%.
4. Reload a game page in the store. Expected: each SYP value is now exactly USD × 140 rounded up to the whole pound.
5. Put the step back to the value you noted before starting. Expected: saved; the store's SYP values are back to the ones from 3.3 step 3 (at 140).

Result: ✅ 2026-10-15

### 3.9 Only the admin can change the rate

**What this checks:** the rate is set on the server by the signed-in admin only; a customer or a stranger cannot read or change it through the API.

1. In the store browser (signed in as TC1) open `https://digital-admin.vertexmedia.pro/api/admin/rates`. Expected: 401, no rate data.
2. Open `https://digital.vertexmedia.pro/api/admin/rates` (the store host). Expected: 404.

Result: ✅ 2026-10-15

### 3.10 The audit log has every rate change and the deposit

**What this checks:** every rate the store ever used can be traced to who set it, when, and from what.

1. In "سجل التدقيق" filter the entity type "سعر الصرف" (exchange rate).
2. Expected: one entry per save of this feature (145, 160, 140, step 1, the step back), newest first, the admin as actor, and none for the refused attempts of 3.2, 3.7 and 3.8.
3. Open the 160 entry. Expected: labelled before and after values (rate and step) and the change percent.
4. Filter TC1 as actor (or the entity type deposit). Expected: the deposit's creation (currency SYP, 2,000, $14.28, the rate) and its cancellation; **no** requote and **no** submission entry.

Result: ✅ 2026-10-15

### 3.11 Screens quality on desktop and phone

**What this checks:** the rate and the pounds read clearly for the admin and for a customer on a phone.

1. On the PC, open "سعر الصرف" in the light and dark themes. Expected: readable, RTL, Latin digits; the rate and confirmation fields keep their digits left to right.
2. On the phone, open "سعر الصرف" in the panel. Expected: the form and the history fit, the history table scrolls inside its card, no horizontal page scroll.
3. On the phone, as TC1, open "المحفظة", a game page and the deposit form with "ل.س" chosen, in both themes. Expected: the SYP lines readable, the number keyboard on the amount field, no horizontal scroll.

Result: ✅ 2026-10-15

### Feature 3 sign-off

| Item | Value |
|---|---|
| Cases passed | 11 of 11 |
| Findings | F3-1, F3-3 (minor), F3-2 (major), from the code audit and its independent review; F3-4 (blocker), F3-5 to F3-7 (minor), from the second review by another model; all fixed |
| Accepted by the owner on | 2026-10-15; audit and fixes by Claude on 2026-10-15 |
| PR | #106 (the steps), #107 (the record, F3-1 to F3-3), #108 (the second review's fixes, F3-4 to F3-7); deployed with 877c951 on 2026-10-15 |

---

## Feature 4 — Sham Cash deposits (F05, with the deposit parts of F07 and F27)

**What it covers:** the customer's Sham Cash deposit from the form to the credit (S03 SC1–SC15): the limits of a new and an established account, the one open deposit, the account, QR and reference code with their copy buttons, the receipt and its file checks, the status page with the real review time; the admin's review (RV1–RV10): the queue and its badge, the receipt viewer and customer panel, the fraud flags (FL1–FL6), approval with what was really received, re-authentication on flags, rejection with a reason, the clearer-receipt request, a transaction number used once across deposits and manual adjustments (SC14); the deposit parts of F07 (S05 TC1–TC6, RM1–RM4): the Telegram card, approval and rejection from Telegram, the card updates and the review reminder; and the deposit parts of F27 (NT1–NT8): the bell, the notifications page, the emails and the email preference for one event; and the expiry of a deposit that never got a receipt (SC12).

**How to read a case:** as in feature 2: **What this checks** first, then the numbered steps; a line starting with "Expected" is what you must see.

**Real money in this feature:** three real transfers from your own Sham Cash account to the store's Sham Cash account, **700 ل.س each** (2,100 ل.س, $15.00 at 140), in cases 4.3, 4.5b and 4.6, all credited to TC1 (the third was added during the run, F4-1). They stay in TC1's wallet for the purchases of features 11–14, and features 6 and 22 check them again. Every other deposit in this feature carries a harmless image and is rejected, which moves no money. **Never approve a deposit whose transfer you cannot see in the store's Sham Cash account**: a credit without real pounds behind it would break the reconciliation of feature 22.

**Before you start**

- The panel open on the PC (signed in), the store as TC1 in a second browser, the store as TC3 in a private window, and your phone with the bot's Telegram chat and the Sham Cash app (at least 1,400 ل.س), plus access to the store's Sham Cash account history (to read the transaction numbers).
- Start between 10:00 and 19:30 Damascus time: the cases take about 2 hours, and the review time and the reminder are only shown within the review hours (10:00–22:00).
- "تيليجرام" (`/settings/telegram`) shows the bot linked to your chat. If not, link it (re-authentication) and note it here; the bot's commands are feature 20.
- "إعدادات الإيداع" (`/settings/deposits`), written down before you start: the account name and number are the store's real Sham Cash account; "الإيداع بالليرة السورية" is on with its QR; the limits are the defaults ($2.00; new account $50.00 and $100.00; established $300.00 and $1,000.00); the review hours 10:00–22:00 with a target of 15 minutes; the flag thresholds $25.00 and 3; "حد الاعتماد من تيليجرام ($)" 100. Note any difference, and whether "الإيداع بالدولار" is on (case 4.8 uses it if so).
- "سعر الصرف" (`/rates`): 140, as feature 3 left it.
- TC1 and TC3 have no deposit waiting for a receipt and no deposit in the last 24 hours except feature 3's cancelled one; TC3 has never had a deposit credited. Neither shares its phone number with another customer (otherwise every deposit carries "رقم هاتف مشترك" and Telegram approval is refused): if one does, change it on `/account` first.
- Note TC1's balance on `/wallet` (expected: $0.00). TC1's email preferences (`/account` → "الإشعارات") are all on.
- Two harmless images on the PC (any screenshots, **not** receipts), and a PDF or a text file.

**Worked numbers used below** (rate 140, FX6 rounds down to the cent): 700 ل.س is **$5.00**; 1,000 ل.س is **$7.14**; 4,200 ل.س is **$30.00**; 200 ل.س is $1.42 (under the $2.00 minimum); 7,100 ل.س is $50.71 (over a new account's $50.00).

**Not tested on production (by design):** the 24-hour totals ($100.00 and $1,000.00) and the cap of 3 deposits in review (they need many open deposits), approval above $100 (it needs a $100 transfer; re-authentication is still checked through flags in 4.6), `receipt_similar` (a near copy of an image), the review time outside hours (unless you run 4.3 after 22:00), and two approvals or two transaction-number claims at the same instant: the automated tests cover them (S03 money and concurrency tests). The ledger postings of the credits are checked in feature 6, the switches that stop deposits in feature 21, the bot's commands and daily summary in feature 20, web push in feature 19.

### 4.1 The form and its limits for a new account

**What this checks:** before sending anything, the customer sees how much they may deposit, and an amount outside the limits is refused before a deposit exists.

1. In the store as TC1 open "المحفظة" → "إيداع". Expected: the method choice offers "شام كاش" (USDT is feature 5); choose it, then "ل.س".
2. Expected: the limits line "أقل مبلغ $2.00 · أقصى مبلغ للإيداع $50.00 · المتبقي اليوم $100.00" (TC1 is a new account), and the review hours 10:00 to 22:00 Damascus time with the expected review time.
3. Enter `200` and press "متابعة". Expected: under the field "أقل مبلغ للإيداع $2.00. أدخل مبلغًا أكبر."; "إيداعاتي" lists no new deposit.
4. Enter `7100`. Expected: "أقصى مبلغ للإيداع الواحد في حسابك $50.00. أدخل مبلغًا أصغر."
5. Enter `700.5`, then `٧٠٠`. Expected: each refused with "أدخل عددًا صحيحًا من الليرات بأرقام لاتينية، مثل 2000."

Result: ✅ (2026-10-16)

### 4.2 The deposit page: account, QR, amount and reference code (deposit A)

**What this checks:** the customer has everything needed to make the transfer right the first time, each value one tap from the clipboard, and cannot open a second deposit by mistake.

1. Enter `700`. Expected: "ستحصل على $5.00" and "بسعر 140 ل.س للدولار". Press "متابعة".
2. Expected, step 1 "أرسل المبلغ إلى حساب المتجر في شام كاش": "اسم الحساب" and "رقم الحساب" as in the settings, each with a copy button; the QR (tapping it enlarges it); "المبلغ المطلوب إرساله" 700 ل.س with a copy button; "يُضاف إلى محفظتك $5.00"; the 15-minute rate countdown.
3. Expected, step 2 "اكتب رمز المرجع في ملاحظة التحويل": the reference code, `VD-` and 5 characters, large, with "اكتب هذا الرمز في ملاحظة التحويل" and a copy button. Step 3 "أضف صورة الإيصال". At the bottom "ينتهي الإيداع إن لم يصل الإيصال خلال" about 24 hours.
4. Press each copy button. Expected: "نُسخ" each time; pasted into any text field, each value is exact (no extra spaces or marks). Write down the reference code: this is **A**.
5. Open "المحفظة" → "إيداع" again. Expected: you land back on A (one deposit waiting for a receipt at a time).
6. In the panel open "الإيداعات" → "بانتظار الدفع". Expected: A is listed with TC1 and 700; the navigation badge did not change (it counts deposits in review only).

Result: ✅ (2026-10-16)

### 4.3 The first real transfer and its receipt (deposit A)

**What this checks:** a real customer's transfer: the receipt goes in easily from the PC or the phone, and the customer is told honestly how long the review takes.

Real money: **700 ل.س**.

1. In your Sham Cash app send exactly 700 ل.س to the store's account, with A's reference code in the transfer note. Take a screenshot of the success screen: this is A's receipt. Do it within the 15-minute lock; if the lock ran out, sending the receipt shows "تغيّر سعر الصرف": accept it (at an unchanged 140 the dollars stay $5.00).
2. On A's page copy some text, then press "لصق". Expected: a hint that the clipboard holds no image (or that the browser does not allow reading it); nothing is attached.
3. Add A's receipt (on the PC, or on the phone signed in as TC1). Expected: a preview with "إزالة". Press "أرسل الإيصال".
4. Expected: "قيد المراجعة", "نراجع التحويل في حساب المتجر. تتحدّث هذه الصفحة تلقائيًا.", the expected time (about 15 minutes, the target, until 5 deposits have been decided), the amount and the reference code. Keep this page open.

Result: ✅ (2026-10-16)

### 4.4 The review queue and the Telegram card (deposit A)

**What this checks:** the admin learns of a deposit at once, on the phone and in the panel, with everything needed to judge it on one screen.

1. In the panel, within 30 seconds: the "الإيداعات" badge shows 1 (not red). "قيد المراجعة" lists A: reference, TC1 with the test badge, 700 ليرة سورية with $5.00, the waiting time, no flag chips.
2. On the phone, Telegram: a card "🧾 إيداع شام كاش VD-…" with A's receipt, "المبلغ: 700 ل.س ≈ $5.00 (السعر 140)", "العميل: <TC1's name> · حساب جديد", "أُرسل:" with the Damascus time, the link to the panel, and the buttons "اعتماد $5.00" and "رفض". Do not press yet.
3. Open the card's panel link on the PC. Expected: A's page: the receipt with zoom, rotate and "فتح الصورة في نافذة جديدة"; "بيانات الإيداع" with 700, $5.00, rate 140 "ثابت منذ …"; "لا تنبيهات على هذا الإيداع."; the customer panel with "حساب جديد", "إيداعات مضافة" 0, feature 3's cancelled deposit under "آخر الإيداعات", and the balance.
4. In "الكل", search A's reference code, then TC1's email. Expected: A found both ways.

Result: ✅ (2026-10-16), accepted by the owner with F4-1: A's card carried "رقم هاتف مشترك" (TC1's phone is also another customer's), so the flag chip in step 1 and "لا تنبيهات" in step 3 did not hold, a setup issue; everything else as expected. The store behaved as designed.

### 4.5 Approval from Telegram (deposit A)

**Run as changed (F4-1):** A carries a flag, so its card offers only "رفض" and A is approved **in the panel**: steps 1 and 6–8 as written, and instead of steps 2–5, "اعتماد الإيداع" on A's page with its transaction number, 700 ل.س, reference "يطابق", the "رقم هاتف مشترك" flag ticked (re-authentication); in step 8 the decision has no "من تيليجرام" badge in the deposit's audit trail (only bot decisions carry one). Then change TC1's phone on `/account` to one no other customer has (TC3's too if it shares it). The Telegram approval itself is case 4.5b.

**What this checks:** an ordinary deposit is credited from the phone in under a minute, only with the real transaction number and a confirm step, and the customer sees it at once without reloading.

1. In the store's Sham Cash account history find A's 700 ل.س transfer with A's code in its note. Expected: it is there. Copy its transaction number. If it is not there, stop: do not approve.
2. On A's card tap "اعتماد $5.00". Expected: "أرسل رقم عملية شام كاش لـ VD-…. تأكد من وصول التحويل في حساب شام كاش نفسه، لا من الصورة."
3. Send the transaction number. Expected: "اعتماد VD-…: إضافة $5.00 برقم العملية …؟" with "تأكيد" and "إلغاء".
4. Tap "تأكيد". Expected: "✅ اعتُمد VD-…: أُضيف $5.00 إلى رصيد العميل.", and the card now starts with "✅ أُضيف $5.00 (من تيليجرام)" and has no buttons.
5. Tap "تأكيد" on the confirm message a second time. Expected: nothing is credited again (step 6 shows one $5.00 only).
6. In the store as TC1, without reloading: the bell shows 1, and A's page turns to "أُضيف المبلغ إلى محفظتك" with $5.00, 700 ل.س بسعر 140 and the time. "المحفظة": the balance is $5.00 more than noted, and the timeline has "إيداع شام كاش" with A's code and "700 ل.س بسعر 140". "الإشعارات": "أُضيف $5.00 إلى رصيدك (VD-…)." marked "جديد"; it opens A.
7. TC1's inbox: the credited email with $5.00, A's code and a link to A. Expected: no transaction number, no receipt, no note.
8. In the panel reload A. Expected: "القرار" with "المضاف" $5.00, "المستلم" 700 ل.س, the rate, the transaction number, "مطابقة الرمز" يطابق, the journal, the admin and "من تيليجرام". The badge is back to 0.

Result: ✅ as changed (2026-10-16): A approved in the panel, the decision card as expected; F4-2 noticed on the receipt viewer.

### 4.5b Approval from Telegram (deposit A2)

**What this checks:** the steps 2–8 of 4.5 on a deposit with no flag, since A could not be approved from Telegram (F4-1).

Real money: **700 ل.س**.

1. As TC1 (phone already changed), "إيداع" → "ل.س" → `700`. Expected: "ستحصل على $5.00", and the limits line "أقصى مبلغ للإيداع $300.00 · المتبقي اليوم $995.00" (TC1 is established since A). Press "متابعة": this is **A2**.
2. Send 700 ل.س with A2's code in the note, add its receipt and send it.
3. Telegram: A2's card has no "⚠️", "العميل: … · 1 إيداعات سابقة", and the buttons "اعتماد $5.00" and "رفض". If it still says "رقم هاتف مشترك", stop: another customer still has TC1's phone.
4. Run steps 1–8 of 4.5 on A2 (A2's transaction number, A2's code). Expected as written there, with the balance $10.00 more than noted and the bell at 2.

Result: ✅ (2026-10-16)

### 4.6 Approval in the panel: a different amount and no reference (deposit B)

**What this checks:** when the transfer differs from what was declared, the admin enters what actually arrived, the store credits only that, and the admin must confirm every warning and their identity first; a deposit above the Telegram limit can only be approved in the panel; two tabs cannot credit twice.

Real money: **700 ل.س**. Do steps 1 and 9 in one sitting each (re-authentication lasts 5 minutes).

1. In the panel, "إعدادات الإيداع": set "حد الاعتماد من تيليجرام ($)" to `1` and save (re-authentication).
2. As TC1, "إيداع" → "ل.س" → `1000`. Expected: "ستحصل على $7.14", and the limits line now reads "أقصى مبلغ للإيداع $300.00 · المتبقي اليوم $990.00" (TC1 is established since A: $1,000.00 less the $10.00 of A and A2). Press "متابعة" and write down the code: this is **B**.
3. In Sham Cash send **700** ل.س (not 1,000) to the store's account, **without** any note. Add the screenshot to B and send it.
4. Telegram: B's card reads "المبلغ: 1,000 ل.س ≈ $7.14 (السعر 140)", "العميل: … · 2 إيداعات سابقة", the line "فوق حد تيليجرام، الاعتماد من اللوحة", and only the button "رفض".
5. In the panel open B in two tabs. In the first, "اعتماد الإيداع": Expected, the warning "اعتمد فقط بعد رؤية التحويل في سجل حساب شام كاش للمتجر نفسه…". Enter the transaction number of the second transfer, keep "العملة المستلمة" in pounds, change "المبلغ المستلم بالليرة" from 1,000 to `700`, and choose "مفقود" for the reference. Expected: "يُضاف إلى المحفظة" $5.00; two flags to tick: "مبلغ مختلف" ("المعلن 1,000 ل.س، والمستلم 700 ل.س") and "رمز المرجع مفقود"; and "يُطلب تأكيد الهوية قبل الاعتماد…".
6. Press "اعتماد وإضافة $5.00" without ticking. Expected: "أكّد الاطلاع على كل التنبيهات قبل الاعتماد."; nothing credited.
7. Tick both, press again. Expected: the re-authentication dialog, then B is decided with "المضاف" $5.00 and "المستلم" 700 ل.س, and both flags shown. Telegram: B's card starts with "✅ أُضيف $5.00 (من اللوحة)". TC1: the bell grows by one, the balance is $15.00 more than noted, and the credited email arrives.
8. In the second tab (still showing the form) fill the same values and approve. Expected: "تغيّرت حالة الإيداع. أعد تحميل الصفحة."; TC1's balance does not change.
9. Put "حد الاعتماد من تيليجرام ($)" back to 100 (re-authentication).

Result: ✅ (2026-10-16)

### 4.7 Another customer's receipt (deposit C, TC3)

**What this checks:** a copy of someone else's receipt is caught at once, its transaction number cannot be credited a second time by any route, and the deposit can be rejected from the phone.

No transfer in this case.

1. As TC3 (private window), "إيداع" → "ل.س" → `4200`. Expected: "ستحصل على $30.00", with a new account's limits. Press "متابعة" (this is **C**), add **A's receipt** (the same file as in 4.3) and send it.
2. Telegram: C's card has "⚠️" with "إيصال مكرّر" and "مبلغ كبير لحساب جديد", the line "عليه علامات، الاعتماد من اللوحة", and only "رفض".
3. In the panel: the badge is red with 1; C is first in "قيد المراجعة" with its flag chips. Open C. Expected: "إيصال مكرّر" with "الإيداع الآخر" opening A (TC1's) and "إيصاله"; "مبلغ كبير لحساب جديد" with "المبلغ $30.00، وحد التنبيه $25.00"; the customer panel says "حساب جديد".
4. Try to approve C with **A's transaction number**, 4,200 ل.س, reference "يطابق", both flags ticked (re-authentication). Expected: refused with "هذا الرقم المرجعي مسجَّل من قبل لهذه الطريقة." and "افتح الإيداع الذي سُجّل له هذا الرقم" opening A; C is still in review and TC3's balance is $0.00. If C is credited, stop: log a blocker (the credit is corrected in feature 6).
5. Open TC1's wallet in the panel (`/wallets/<id>`) → "تعديل الرصيد": a credit of `1` with the category "إيداع مسجَّل يدوياً", the method Sham Cash, and as "رقم العملية أو TXID" A's transaction number in lowercase with a space before and after; any internal reason; "سجّل التعديل" (re-authentication). Expected: refused because the number is already used; TC1's balance does not change. If it is accepted, stop: log a blocker (reversed in feature 6).
6. Telegram: on C's card tap "رفض". Expected: "سبب رفض VD-…؟ (سبب آخر أو ملاحظة للعميل من اللوحة)" with one button per reason. Tap "الإيصال مستخدم سابقاً". Expected: "رفض VD-…: الإيصال مستخدم سابقاً. أرسل ملاحظة داخلية (من 5 إلى 500 حرف)، لا يراها العميل."
7. Send `abc`. Expected: "الملاحظة من 5 إلى 500 حرف. أرسلها من جديد." Send `System test: copy of the receipt of A`. Expected: "❌ رُفض VD-…: الإيصال مستخدم سابقاً." and the card starts with "❌ رُفض: الإيصال مستخدم سابقاً".
8. As TC3: C's page "رُفض الإيداع" with "الإيصال مستخدم في إيداع سابق" and "إيداع جديد"; the bell, and "رُفض الإيداع VD-…: الإيصال مستخدم في إيداع سابق." in "الإشعارات"; TC3's inbox has the rejection email with the reason and without the internal note.
9. Copy C's address from TC3's window and open it in TC1's browser. Expected: the 404 page.

Result: ✅ (2026-10-16)

### 4.8 Bad files, the reminder, a clearer receipt and a rejection in the panel (deposit D)

**What this checks:** a wrong file is refused with a clear message; a receipt left waiting is pushed to the admin; the admin can send a deposit back once for a better image, and reject it with a note only the customer sees; an email turned off stops only that email.

No transfer in this case. **Never approve D**, whatever its card offers.

1. As TC1, `/account` → "الإشعارات": turn off "عند رفض إيداع". Expected: "حُفظ اختيارك."; the security row "رسائل الأمان (رموز التحقق، تغيير كلمة المرور، تسجيل دخول جديد)" reads "تصل دائمًا" and cannot be changed.
2. "إيداع": if "الإيداع بالدولار" is on, choose "$" and `5`; otherwise "ل.س" and `700`. Press "متابعة" (this is **D**). Note which currency was used.
3. Add the PDF or text file and press "أرسل الإيصال". Expected: "الملف ليس صورة صالحة. أرسل لقطة شاشة بصيغة JPEG أو PNG أو WebP." (when the picker or the browser stops it first, a message to choose an image); D still waits for a receipt.
4. Add harmless image 1 and send it. Note the time. Expected: a new Telegram card for D with "⚠️ إيداعات متلاحقة" (TC1's fourth receipt in 24 hours, after A, A2 and B, F4-1) and "عليه علامات، الاعتماد من اللوحة": only "رفض".
5. Leave D waiting. Expected: between 15 and 20 minutes after step 4, a Telegram reminder "⏰ 1 إيداع بانتظار المراجعة، أقدمها منذ … د" with D's code and its wait, and the panel link. Optional: a second reminder about 30 minutes after the first while D still waits.
6. In the panel open D → "طلب إيصال أوضح": customer note `أرسل لقطة الشاشة كاملة`, internal note `System test: clearer receipt`, "إرسال الطلب". Expected: D is back in "بانتظار الدفع"; "طلب إيصال أوضح" is no longer offered on D; the card starts with "↩️ طُلب إيصال أوضح" and has no buttons.
7. As TC1: "نحتاج إيصالًا أوضح للإيداع VD-…. افتحه وأرسل صورة جديدة." in "الإشعارات"; the email (that preference is still on). D's page shows "طُلب إيصال أوضح", "الإيصال السابق غير واضح. أضف صورة أوضح للتحويل نفسه." and your note; for pounds "السعر ثابت: 140 ل.س للدولار" with no countdown (the rate was fixed by the first receipt); the deposit's time left is again about 24 hours.
8. Add harmless image 2 and send it. Expected: a new card with "⚠️ إيداعات متلاحقة" (TC1's fifth receipt in 24 hours) and "عليه علامات، الاعتماد من اللوحة". In the panel D shows "إيداعات متلاحقة" with "5 إيصالات خلال 24 ساعة، والحد 3", and the viewer has "الإيصال الأحدث" and "الإيصال السابق".
9. "رفض": reason "الإيصال غير صالح أو معدَّل", customer note `System test: no real transfer`, an internal note, "رفض الإيداع". Expected: D rejected; its card starts with "❌ رُفض: الإيصال غير صالح أو معدَّل"; TC1's D page shows the reason and the customer note; "الإشعارات" has the rejection; **no** rejection email in TC1's inbox.
10. Turn "عند رفض إيداع" back on.

Result: ✅ (2026-10-16)

### 4.9 Only the right people see deposits and receipts

**What this checks:** deposits and receipt images are reachable by the admin only, never through a customer session or the store host.

1. In TC1's browser open `https://digital-admin.vertexmedia.pro/api/admin/deposits`. Expected: 401, no data.
2. Open `https://digital.vertexmedia.pro/api/admin/deposits`. Expected: 404.
3. In the panel open A's receipt with "فتح الصورة في نافذة جديدة" and copy that address; open it in TC1's browser. Expected: 401, no image.
4. TC1's "إيداعاتي": A, A2 and B credited, D rejected, feature 3's cancelled deposit; C is not listed.

Result: ✅ (2026-10-16)

### 4.10 The audit log has every deposit step and decision

**What this checks:** every deposit can be traced from its creation to its decision, with who decided, from where, and on what evidence.

1. In "سجل التدقيق" filter the entity type deposit.
2. Expected, per deposit: A created, submitted, credited (panel, F4-1); A2 created, submitted, credited (channel Telegram); B created, submitted, credited (panel); C created, submitted, rejected (Telegram); D created, submitted, clearer receipt requested, submitted, rejected. Nothing for the refused attempts of 4.1 or the refused approvals of 4.6 and 4.7.
3. Open B's credit. Expected: labelled transaction number, received currency and amount, credited $5.00, the reference check "مفقود", both acknowledged flags, the journal and the balance after; the internal note if you typed one.
4. Filter the entity type deposit settings: the two saves of 4.6 (limit 100 → 1 → 100). Filter TC1 as actor: the two email-preference changes of 4.8. No wallet adjustment from 4.7.

Result: ✅ (2026-10-16)

### 4.11 Screens and emails quality on desktop and phone

**What this checks:** a customer on a phone and the admin on either device can do every step without guessing.

1. On the phone as TC1, in both themes: the deposit form, a pending deposit (QR enlarged, copy buttons), the submitted, credited and rejected pages, "إيداعاتي", "الإشعارات" and the account's notification switches. Expected: readable, RTL, Latin digits, the reference code and account number left to right, the number keyboard on the amount, no horizontal scroll.
2. On the PC, the panel in the light and dark themes: the queue with flag chips, a deposit page with the approve form and its flags, the reject and clearer-receipt dialogs. On the phone: the queue and a deposit page usable, the receipt zoomable.
3. The emails of this feature (credited, clearer receipt, rejected): the brand header, Arabic RTL, the right amount and code, a working link to the deposit, nothing internal.
4. The Telegram cards: the receipt readable, the caption Arabic and complete, amounts with Latin digits.

Result: ✅ (2026-10-16)

### 4.12 A deposit with no receipt expires after 24 hours (deposit E, the next day)

**What this checks:** an abandoned deposit closes by itself, so the customer is never stuck with it and no old reference code stays open.

Steps 1 and 2 can be run after the rest; the feature is accepted once step 2 passes.

1. At the end of the sitting, as TC3: "إيداع" → "ل.س" → `700` → "متابعة" (this is **E**). Send nothing. Note the time.
2. The next day, more than 24 hours and 5 minutes later: TC3's E page reads "انتهت مدة الإيداع" with "لم يصل إيصال خلال 24 ساعة…" and "إيداع جديد"; the panel lists E as "منتهي"; the audit log has E's expiry with the system as actor. No email, no Telegram card.

Result: step 1 done 2026-10-16 15:34 Damascus (E is VD-M5YGF); step 2 due after 2026-10-17 15:39.

### Feature 4 sign-off

| Item | Value |
|---|---|
| Cases passed | 12 of 13; 4.12 step 1 done, step 2 due after 2026-10-17 15:39 |
| Findings | F4-1 (setup, closed); F4-2 to F4-16 fixed: one blocker (F4-3), three major (F4-9 to F4-11), the rest minor; an independent review, a review of its fixes, and a second review by another model |
| Accepted by the owner on | 2026-10-16 |
| PR | the steps (#110); the results and fixes (#113), merged and deployed to production on 2026-10-16 (`18336fe`, recorded in #114) |

---

## Feature 5 — USDT deposits (F06, with the USDT parts of F07 and F27)

**What it covers:** the customer's USDT deposit on TRON (TRC20) and BNB Smart Chain (BEP20) from the form to the credit (S04): the networks offered and why one is unavailable, the USDT minimum and the shared limits (U5), the exact amount with its sub-cent tail, the address with its QR and groups of four, the warnings; the automatic detection of an exact transfer with no TXID (U12), the optional TXID and its states (searching, confirming with progress; U8, U9), a TXID that is not a transfer to the store bounced with its reason (U10), a short payment sent to review (U11); the admin's side: the queue and its badge, the USDT deposit page with the transfer, the difference and the candidates, the re-check (U17), approval of the received amount with the flag and re-authentication (U15), rejection from Telegram (U16, S05 TC5), the incoming transfers list with an unmatched transfer recorded through the manual deposit form (U13), a TXID counted once across deposits and manual deposits; the per-network switches of the deposit settings; the USDT parts of F07 (the review card with "رفض" only, TC3; the unmatched-transfer message, TC7) and of F27 (the bell, the credited and rejected emails).

**How to read a case:** as in features 2 to 4: **What this checks** first, then the numbered steps; a line starting with "Expected" is what you must see.

**Real money in this feature:** four real USDT transfers from your own wallet or exchange to the store's addresses, **$15.37 plus the tails and the network fees**, all credited to TC1:

| Case | Network | You send | TC1 gets |
|---|---|---|---|
| 5.3 | TRC20 | $5 + the tail its page shows (for example `5.0037`) | $5.00, automatically |
| 5.4 | BEP20 | $5 + the tail its page shows | $5.00, automatically |
| 5.6 | BEP20 | **exactly $1 less** than its page shows (`4.0052` for `5.0052`) | $4.00, approved by you in 5.7 |
| 5.8 | BEP20 | `1.37`, with no deposit open | $1.37, recorded by you as a manual deposit |

Send from the wallet or exchange of the 2026-10-14 live check, which delivered four decimals in full (1.5024 and 3.0075). **What arrives must be what the page shows:** if your platform takes its withdrawal fee out of the amount, add the fee, or the exact cases go to review instead. TC1 keeps the $15.37 for the purchases of features 11–14; features 6 and 22 check them again. **Never record a manual deposit for a transfer you cannot see on the explorer**: a credit without real USDT behind it would break the reconciliation of feature 22.

**Before you start**

- The panel open on the PC (signed in), the store as TC1 in a second browser, the store as TC3 in a private window, and your phone with the bot's Telegram chat and the wallet or exchange you send from (about $16 of USDT across the two networks, plus their fees). Tronscan and BscScan open in tabs help to read TXIDs.
- Any time of day: USDT is checked automatically day and night. The cases take about 1 hour 30 minutes.
- "تيليجرام" (`/settings/telegram`) shows the bot linked to your chat.
- "إعدادات الإيداع" (`/settings/deposits`), written down before you start: in the USDT section both networks show their "عنوان الاستلام" (read-only) with the switch on and "آخر قراءة ناجحة:" within the last few minutes, no "التحقق متأخر"; "أقل مبلغ لإيداع USDT" $5.00 (note it if the live check left it lower); the limits as feature 4 left them (TC1 is established: $300.00 per deposit, $1,000.00 per 24 hours).
- No deposit method is paused in the store switches (pausing is feature 21).
- TC1 has no deposit waiting: feature 4's are all decided. TC3 still has deposit E of 4.12 waiting until 2026-10-17 15:39, so TC3 only reads in this feature.
- Note TC1's balance on `/wallet` (expected: $15.00, feature 4's three credits). TC1's email preferences are all on.
- "تحويلات USDT" in the panel: "الكل" lists the live check's two transfers as "مُضاف"; "غير المطابقة" is empty.

**Worked numbers used below:** a $5.00 deposit shows `5.00xx` USDT, where `xx` is its own tail (0.0001 to 0.0099; two open deposits of one network never share an amount). The tail goes to the store's rounding account and the customer is credited the $5.00 asked for. A transfer that is not exact is credited, if approved, at what arrived floored to the cent: `4.0052` is **$4.00**, `1.37` is **$1.37**.

**Not tested on production (by design):** a TXID not found after 30 minutes and 10 reads, a failed transaction, a fake "USDT" token, a transfer under $1 (dust), a transfer on the other network (`wrong_network`), an exact transfer sent before its deposit, the network "التحقق متأخر" (the scanner stopped for 10 minutes), all 99 tails of one amount busy, the 5 TXID submissions per deposit and 20 per hour, the 24-hour expiry of a USDT deposit (the job 4.12 checks), and two credits of one transfer at the same instant: the automated tests cover them (S04 rule and concurrency tests). The ledger postings and the rounding account are checked in feature 6, the per-method pause and the emergency stop in feature 21, the bot's commands and daily summary in feature 20, the on-chain balances against the books in feature 22, web push in feature 19.

### 5.1 The settings and the networks offered

**What this checks:** the receiving addresses are the owner's and cannot be changed from the panel, and the store offers only the networks that work.

1. In the panel open "إعدادات الإيداع". Expected: the USDT section with "عنوان الاستلام" for TRC20 (`T…`) and BEP20 (`0x…`), each exactly your wallet's address (compare every character with your wallet), with "يُغيَّر من إعدادات الخادم فقط" and no way to edit it; each network's switch and "آخر قراءة ناجحة:".
2. In the store as TC1 open "المحفظة" → "إيداع". Expected: the method choice offers "شام كاش", "USDT (TRC20)" and "USDT (BEP20)", all enabled.

Result: ✅ (2026-10-16). The owner asked why the addresses cannot be changed from the panel, and about a wallet-style QR: answered in chat (kept server-only, ADR 0018); see F5-4

### 5.2 The form and its limits

**What this checks:** the customer sees the network and the limits before anything is created, and a wrong amount is refused before a deposit exists.

1. Choose "USDT (TRC20)". Expected: "أرسل على شبكة TRON (TRC20) فقط" with "التحويل على شبكة أخرى لا يُضاف تلقائيًا."; the amount in dollars with presets within the limits; the limits line (minimum $5.00, per deposit $300.00, the remaining 24-hour amount); "رسوم الشبكة والمنصة على المرسل."
2. Enter `4.99` and press "متابعة". Expected: "أقل مبلغ للإيداع $5.00. أدخل مبلغًا أكبر."; "إيداعاتي" lists no new deposit.
3. Enter `300.01`. Expected: "أقصى مبلغ للإيداع الواحد في حسابك $300.00. أدخل مبلغًا أصغر."
4. Enter `5.123`, then `٥`. Expected: each refused with "أدخل مبلغًا بالدولار بأرقام لاتينية، مثل 25 أو 25.50."
5. Choose "USDT (BEP20)". Expected: the note reads "أرسل على شبكة BNB Smart Chain (BEP20) فقط".

Result: ✅ (2026-10-16)

### 5.3 An exact transfer found with no TXID (deposit A, TRC20)

**What this checks:** a customer who just sends the amount shown, and does nothing else, is credited within minutes without the admin.

Real money: **$5 + tail on TRC20**.

1. "USDT (TRC20)", `5`, "متابعة". Expected, the deposit page: "أرسل هذا المبلغ بالضبط" with `5.00xx` large, its last two digits highlighted, "الرقمان الأخيران يميّزان إيداعك عن غيره…" and "انسخ المبلغ"; the badge "TRON · TRC20"; "عنوان المتجر" with the QR (tap to enlarge), the address in groups of four, "انسخ العنوان" and "انسخ العنوان من هنا دائمًا، لا من سجل محفظتك."; the warning "يجب أن يصل المبلغ كاملًا"; "ننتظر وصول التحويل وسنكتشفه تلقائيًا."; the field "سرّع التحقق (اختياري)"; "ينتهي الإيداع إن لم يصل التحويل خلال" about 24 hours; "إلغاء الإيداع". This is **A**: write down its reference code and amount.
2. Press both copy buttons and paste each into any text field. Expected: the amount and the address exact, with no space or mark. Scan the QR with your wallet: the same address.
3. Open "إيداع" again. Expected: you land back on A (one waiting deposit at a time).
4. In the panel, "الإيداعات" → "بانتظار الدفع": A with TC1, the chip "USDT (TRC20)" and $5.00; the "الإيداعات" badge did not change.
5. From your wallet send A's exact amount on **TRON (TRC20)** to the address copied from A's page. **Do not paste the TXID.** Note the time.
6. Expected, within about 2 minutes, on A's page without a reload: "أُضيف المبلغ إلى محفظتك" with $5.00, the TXID link and the time. The bell: "أُضيف $5.00 إلى رصيدك (VD-…)". The credited email, with no TXID and no address in it. TC1's balance $20.00.
7. In the panel open A. Expected: read-only, decided "تلقائي"; "رقم العملية (TXID)" with "اكتشاف تلقائي" and the explorer link (it opens your transaction); the transfer from your address to the store's, "المستلم" "مطابق تمامًا", block and time. "تحويلات USDT" ("الكل") lists it "مُضاف" with TC1. No Telegram message for A.

Result: ✅ (2026-10-16). The owner asked for a way to credit automatically without the tail: answered in chat; see F5-5

### 5.4 An exact transfer with its TXID pasted (deposit B, BEP20)

**What this checks:** a customer who pastes the TXID sees each step of the check, and a typo is caught before anything is sent.

Real money: **$5 + tail on BEP20**.

1. "إيداع" → "USDT (BEP20)", `5`, "متابعة" (this is **B**). Expected: the badge "BNB Smart Chain · BEP20" and an address starting with `0x`.
2. In "سرّع التحقق" paste `abc` and press "تحقّق الآن". Expected: "رقم العملية غير صالح. الصق رقم العملية (TXID) أو رابطها من Tronscan أو BscScan."; B still waiting.
3. Send B's exact amount on **BNB Smart Chain (BEP20)**. As soon as your wallet shows the TXID (or the BscScan link), paste it into "سرّع التحقق" and press "تحقّق الآن".
4. Expected, without a reload: "نبحث عن العملية على الشبكة" with the TXID and "افتح العملية في مستكشف الشبكة", then "وصل التحويل، ننتظر تأكيد الشبكة" with "تأكيدات الشبكة" "n من 15 تأكيدًا" (on BSC this can pass in seconds: note what you saw), then "أُضيف المبلغ إلى محفظتك" with $5.00. The bell and the email as in 5.3. TC1's balance $25.00.
5. In the panel open B. Expected: "تلقائي", the TXID source "أرسله العميل" (or "اكتشاف تلقائي" if the scanner was first: note which), "مرات إرسال الرقم" 1, "مطابق تمامًا".
6. Telegram: expected no message for B. If "⚠️ تحويل USDT غير مطابق" arrived for B's amount (the scanner saw the transfer while its TXID was being checked), note it.

Result: ✅ (2026-10-16), with F5-3: the scanner found and credited the transfer before the TXID could be pasted, so steps 2–4's searching and confirming were not seen on production

### 5.5 A TXID that is not a transfer to the store (deposit C, no money)

**What this checks:** a customer who pastes a wrong TXID is told why it does not count and can try again; nothing is credited.

1. "إيداع" → "USDT (BEP20)", `5`, "متابعة" (this is **C**; 5.6 uses it again). Write down its exact amount.
2. On BscScan open the BSC-USD (USDT) token page, "Transfers", and copy the transaction hash of a recent transfer between two other addresses. Paste it into C's "سرّع التحقق" and press "تحقّق الآن".
3. Expected, within about a minute: C waiting again, with "التحويل ليس إلى عنوان المتجر" and "تحقّق من رقم العملية وأرسله من جديد. ما زلنا نراقب عنوان المتجر تلقائيًا." above; its amount, address and time left unchanged. No email.
4. In the panel open C. Expected: "بانتظار التحويل", "آخر خطأ" "ليست إلى عنوان المتجر", "مرات إرسال الرقم" 1, "لا تحويل مرتبط بهذا الإيداع بعد."; "تحويلات USDT" did not gain that transaction.

Result: ✅ (2026-10-16)

### 5.6 A short payment goes to review (deposit C)

**What this checks:** money that arrives but does not match is never credited on its own: it waits for the admin, with the reason in plain words for the customer, and the admin learns of it on the phone.

Real money: **C's amount minus exactly $1 on BEP20** (for `5.0052` send `4.0052`).

1. Send C's amount minus $1 on BEP20, then paste its TXID into C's "سرّع التحقق" and press "تحقّق الآن".
2. Expected on C's page, within about a minute: "قيد المراجعة" with "المبلغ المستلم 4.00xx يختلف عن المطلوب 5.00xx." and the review time. No email.
3. Telegram: a card "🔎 مراجعة USDT VD-… · USDT BEP20" with "المستلم 4.00xx USDT، المطلوب 5.00xx", the TXID shortened with its BscScan link, the panel link and one button, "رفض" (no approval from Telegram). Do not press it. A "⚠️ تحويل USDT غير مطابق" message for 4.00xx may come first (the scanner saw it before the TXID check): note whether it did.
4. In the panel: the "الإيداعات" badge shows 1; "قيد المراجعة" lists C with "USDT (BEP20)" and the flag "مبلغ مختلف".
5. Open C. Expected: the facts ("الشبكة", "العنوان المعروض للعميل", "المبلغ المطلوب" 5.00xx, "الكسر المميِّز", the declared $5.00); the TXID "أرسله العميل" with its explorer link; the transfer with "المستلم" 4.00xx and "أقل بـ $1.00"; the flag; "الإيداعات المرشحة" lists other reserved deposits with this amount or tail, so here "لا إيداعات أخرى مرشحة." (F5-1); the customer panel.
6. Press "إعادة التحقق". Expected: "أُرسل التحقق"; C stays in review with the same facts.

Result: ✅ (2026-10-16), with F5-1 and F5-2. C was a $4.00 deposit (4.0056) and 3.0056 was sent, the owner's choice; "الإيداعات المرشحة" read "لا إيداعات مرشحة."

### 5.7 Approving the received amount in the panel (deposit C)

**What this checks:** the admin credits what really arrived, never a typed amount, and only after acknowledging the flag and confirming who they are.

1. On C's page, the approve form. Expected: the button "اعتماد وإضافة $4.00", "المبلغ المضاف هو المستلم على الشبكة مقرّبًا إلى السنت الأدنى، ولا يُكتب يدويًا…", no amount field, the flag's tick, an internal note, and "يُطلب تأكيد الهوية دائمًا قبل اعتماد إيداع USDT."
2. Press the button without ticking the flag. Expected: refused until the flag is ticked.
3. Tick the flag, type an internal note, press it. Expected: the re-authentication dialog (unless you re-authenticated in the last 5 minutes); then C credited $4.00, decided by you, read-only. The Telegram card shows the outcome, with no button.
4. In the store: C's page "أُضيف المبلغ إلى محفظتك" with $4.00; the bell and the email with $4.00. TC1's balance $29.00.
5. "تحويلات USDT" ("الكل"): C's transfer "مُضاف" with TC1; "غير المطابقة" empty.

Result: ✅ (2026-10-16)

### 5.8 An unmatched transfer, a rejection from Telegram and a manual deposit (deposit D)

**What this checks:** money that matches no deposit is never lost: the admin sees it, can refuse a customer's claim to it from the phone, and records it once, for the right customer, with its TXID.

Real money: **`1.37` USDT on BEP20**.

1. With no TC1 deposit waiting, send exactly `1.37` on BEP20 to the store's BEP20 address (from B's page or the panel's settings). Write down the TXID.
2. Expected, within about 2 minutes: Telegram "⚠️ تحويل USDT غير مطابق على USDT BEP20" with "المبلغ: 1.3700 USDT", your address shortened, no candidates, and the panel link. In the panel "تحويلات USDT" carries the badge "تحويلات غير مطابقة: 1"; "غير المطابقة" lists it "غير مطابق" with "تسجيل إيداع يدوي". Do not record it yet.
3. As TC1: "إيداع" → "USDT (BEP20)", `5`, "متابعة" (this is **D**). Paste the TXID of step 1 and press "تحقّق الآن".
4. Expected on D's page: "قيد المراجعة" with "المبلغ المستلم 1.3700 يختلف عن المطلوب 5.00xx." and "أُرسل التحويل قبل إنشاء الإيداع."; a review card for D in Telegram. In the panel D carries "مبلغ مختلف" and "تحويل أقدم من الإيداع", and "تحويلات USDT" ("الكل") shows the transfer "قيد المراجعة".
5. On D's Telegram card press "رفض", choose "التحويل يخص طلب إيداع آخر", then send an internal note (for example `System test: transfer sent before this deposit`). Expected: D rejected and its card shows it; TC1's D page "رُفض الإيداع" with the reason and "إيداع جديد"; the bell and the rejection email. TC1's balance unchanged, $29.00.
6. "تحويلات USDT" ("غير المطابقة"): the transfer "غير مطابق" again. Press "تسجيل إيداع يدوي", choose TC1 (search by email), and check the prefilled form: "إيداع مسجَّل يدوياً", BEP20, the TXID, $1.37. Type the internal reason (for example `System test 5.8: 1.37 USDT sent with no deposit`) and save (re-authentication if asked).
7. Expected: the transfer "مُضاف" with TC1; "غير المطابقة" empty and the badge gone; TC1's wallet shows "إيداع مسجَّل يدوياً" +$1.37, balance $30.37.

Result: ✅ (2026-10-16)

### 5.9 A TXID counts once (deposit E)

**What this checks:** a transfer already credited, by a deposit or a manual deposit, can never be claimed again.

1. As TC1: "إيداع" → "USDT (BEP20)", `5`, "متابعة" (this is **E**; no money is sent).
2. Paste the TXID of 5.8 and press "تحقّق الآن". Expected at once: "رقم العملية هذا مستخدم من قبل."; E still waiting.
3. Paste B's TXID (5.4), this time as its BscScan link. Expected: the same refusal.
4. Press "إلغاء الإيداع". Expected: the dialog "إن كنت أرسلت المبلغ فلا تلغِ: سنكتشف التحويل تلقائيًا…"; confirm; E reads "أُلغي الإيداع".

Result: ✅ (2026-10-16)

### 5.10 A network switched off

**What this checks:** the admin can stop new deposits on one network, and customers see it as unavailable instead of failing.

1. In "إعدادات الإيداع" turn the TRC20 switch off and save (re-authentication).
2. In the store as TC1 open "إيداع". Expected: "USDT (TRC20)" disabled with "غير متاح حاليًا"; "USDT (BEP20)" and "شام كاش" enabled.
3. Turn TRC20 on again and save. Expected: after a reload the store offers it again.

Result: ✅ (2026-10-16)

### 5.11 Only the right people see USDT deposits and transfers

**What this checks:** a customer reaches only their own deposits, and the transfers list is the admin's alone.

1. Copy the address of TC1's deposit B page and open it in TC3's private window. Expected: not found, nothing of B shown.
2. In TC1's browser open `https://digital-admin.vertexmedia.pro/api/admin/usdt-transfers`. Expected: 401, no data.
3. Open `https://digital.vertexmedia.pro/api/admin/usdt-transfers`. Expected: 404.
4. TC1's "إيداعاتي": A, B and C credited, D rejected, E cancelled, labelled "USDT (TRC20)" or "USDT (BEP20)", besides feature 4's deposits.

Result: ✅ (2026-10-16)

### 5.12 The audit log has every USDT step and decision

**What this checks:** every USDT deposit can be traced from its creation to its credit, with who decided and on which transfer.

1. In "سجل التدقيق" filter the entity type deposit.
2. Expected, per deposit: A created, "ربط تحويل USDT بإيداع" (exact, source scan), credited (actor system); B created, "إرسال رقم عملية USDT", bound (exact), credited (system); C created, the TXID of 5.5, "رفض رقم عملية USDT تلقائيًا" (`not_to_store`), the TXID of 5.6, bound (review), "إعادة التحقق من إيداع USDT", credited by you with the acknowledged flag; D created, its TXID, bound (review, both flags), rejected (channel Telegram); E created, cancelled. Nothing for the refused amounts of 5.2 or the refused TXIDs of 5.4 step 2 and 5.9.
3. Open C's credit. Expected: the received amount, credited $4.00, the acknowledged flag, the journal and the balance after, your internal note.
4. The manual deposit of 5.8 with its TXID and reason (wallet adjustment entries); the deposit settings: the two saves of 5.10.

Result: ✅ (2026-10-16)

### 5.13 Screens and emails quality on desktop and phone

**What this checks:** a customer on a phone and the admin on either device can do every step without guessing.

1. On the phone as TC1, in both themes: the USDT form, a waiting deposit (the QR enlarged, the amount with its highlighted digits, the address in groups, the copy buttons), the searching, confirming, review, credited, rejected and cancelled pages, a bounce error, "إيداعاتي" and the wallet history. Expected: readable, RTL, Latin digits, the amount, address and TXID left to right, a numeric keyboard on the amount, no horizontal scroll.
2. On the PC, the panel in the light and dark themes: the queue with a USDT row, a USDT deposit page with its transfer and candidates, "تحويلات USDT", the USDT section of the deposit settings. On the phone: the queue, a USDT deposit page and the transfers list usable.
3. The emails of this feature (credited, rejected): the brand header, Arabic RTL, the right amount and reference code, a working link to the deposit, no TXID, address or internal note.
4. The Telegram messages (review card, unmatched transfer): Arabic, complete, amounts with Latin digits, the explorer and panel links working.

Result: ✅ (2026-10-16)

### Feature 5 sign-off

| Item | Value |
|---|---|
| Cases passed | 13 of 13 |
| Findings | F5-1 (step error, the empty-list text made clearer), F5-2 (USDT mismatch line) fixed, F5-3 accepted (the TXID states rest on the automated tests), F5-4 and F5-5 owner questions answered, no change; F5-6 the wallet-style QR (owner request); F5-7 to F5-14 from an external audit by another model (GPT 6.1 sol, review only), each confirmed in the code and fixed: two blockers (F5-7 a cross-network double credit, F5-8 a provider key reaching Sentry), three major, three minor |
| Accepted by the owner on | 2026-10-16; the audit fixes accepted by Claude on 2026-10-17 (every check green, the reviewer's findings closed) |
| PR | the steps (#115); the results and the first fixes (#116); the wallet-style QR and the external audit's fixes (F5-6 to F5-14) in the next PR |
