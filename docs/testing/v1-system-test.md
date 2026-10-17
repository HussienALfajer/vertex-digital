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
| 6 | Wallet and ledger | F03 | Checked once real deposits exist: balances as sums, history, journals | Accepted 2026-10-17 |
| 7 | Catalog | F08 | What is sold: games, packs, fields, images, states | Accepted 2026-10-17 |
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

## After the last feature: the professional catalog

The owner's decision (2026-10-17): once all 22 features are accepted, and before the pilot opens, the owner builds a professional, complete and correct catalog on production, so every game a customer can buy is clear, trustworthy and works without problems. Catalog content findings of this test are deferred here instead of being fixed one by one; any later finding of that kind is added to this list.

**Done when** every item below is checked, the owner has reviewed the store as a customer on a phone and a PC, and a read-only production read (Claude) confirms the counts.

- [ ] **Redemption instructions for code packs (F7-1).** Every active code pack whose game promises "مع خطوات الاستخدام" has its instructions (pack dialog, "تعليمات الاستخدام"), short numbered steps in plain Arabic, one text per game: روبلوكس, ديسكورد نيترو, وياك, جلسات VIP, ستاندوف 2, ماينكرافت, تانجو (13 active packs on 2026-10-17). The other code games either get instructions too or no region note promises them.
- [ ] **Regions for code packs (F7-1).** Every gift card pack whose use depends on the account's country (Google Play, iTunes, PlayStation, Xbox, Amazon, Nintendo, Netflix, Spotify, League of Legends, Fortnite, Valorant) states its region in "المنطقة", matching its game's region note.
- [ ] **ID guide images (F7-2).** Every game that asks for an ID has a "صورة دليل المعرّف" showing where the ID (and server, when asked) is found in the game, with no real person's account visible; first ببجي موبايل, فري فاير, موبايل ليجندز, جنشن إمباكت, هونكاي: ستار ريل and زينلس زون زيرو, then the other 30 of the 36.
- [ ] **Official prices (F7-2).** Entered only where the publisher's real price is known and sourced; otherwise left empty, so no savings badge can mislead.
- [ ] **Accent colors (F7-2, optional).** Per game, from its own brand color, passing the 3:1 check against the dark surface.
- [ ] **Names, covers, region notes and search terms** reviewed for every active game: Arabic names as customers in Syria search them, the English name, a sharp cover, notes that promise only what the store does.
- [ ] **Fields** checked against each game's real ID format (type, bounds, help text), so the buy box refuses a wrong ID before the purchase.
- [ ] **Packs** in a clear order (smallest to largest, offers last), names consistent across games, no active pack without a valid route and price, paused packs only where the supplier cannot deliver them.
- [ ] **Games with no active pack** (Fortnite, Chamet, Spotify, Netflix, Valorant, CapCut Pro, Yalla on 2026-10-17): each either gets a working route or is paused, so the store shows no game that cannot be bought.

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
| F6-1 | 6 | Writing the steps (6.3) | The ledger summary's "الحسابات النظامية" formats every balance with `formatUsd` (`wallets-page.tsx`), whatever the account's currency: `sham_cash_receipts:SYP` at −2,100 ل.س (−210,000 units) would read "-$0.21", and `currency_exchange:SYP` "$0.21" | minor | Each balance is shown in its account's currency with the reconciliation page's `money()` (`−2,100 ل.س`, USD keeping its sub-cent digits); E2E with the deposit accounts in the summary and the screenshots | Fixed (#120), deployed to production on 2026-10-17 (`d5cad4d`) |
| F6-2 | 6 | Before you start | The worked numbers were written from the plan of features 4 and 5, not from what the run recorded: TC1 holds **8** credits and **$28.98** (USDT A was a $2.00 deposit, a second BEP20 deposit with a pasted TXID was credited, the manual deposit was $2.98), not 7 and $29.37; the books table missed the four accounts of the two walk-in admin orders of 2026-10-13 and 14 (`owner_drawings`, `sales_revenue`, `cost_of_goods`, `supplier_prepaid:wdgzone`). Found by a read-only production query (owner's request) before 6.1 | minor (steps) | The worked tables and the expected values of 6.1, 6.3, 6.4, 6.8, 6.9 and 6.12 rewritten from the production records, with this file's PR; the owner ran the corrected steps | Fixed |
| F6-3 | 6 | Before you start (6.3) | The live check's customer of 2026-10-14 (the owner's own account, $4.50 from the two USDT transfers) is not marked as a test customer, so its balance counts under "للعملاء الحقيقيين" and will appear in feature 22's reports as a real customer's | minor | None yet: decide in feature 16 (customers administration) whether to mark it as a test customer or keep it as the first real one, before feature 22 | Open (follow-up) |
| F6-4 | 6 | External audit A1 (GPT 6.1 sol, review only) | The panel's `Idempotency-Key` changed as soon as a field changed, even after an attempt with no answer: an adjustment written whose answer was lost, then retried with an edited note, was written a second time | blocker | `useIdempotentRequest()` (`apps/admin/src/lib/idempotency.ts`) keeps the key whatever changed after an attempt with no answer, a server fault or `IDEMPOTENCY_KEY_REUSED`, until an answer comes back; every money dialog of the panel uses it; the `IDEMPOTENCY_KEY_REUSED` text tells the admin the first request was recorded; unit tests in `idempotency.test.ts` | Fixed |
| F6-5 | 6 | External audit A2 | A first credit sent with the customer id in capitals created `customer_wallet:<CAPITALS>`: the customer's reads found no wallet ($0.00), and later writes failed on the wallet's unique customer | major | `customerWalletCode` keeps the id lower-case, the wallet services use the stored id; API test with an upper-case first credit, its replay in lower case, the reads and the account's code; production holds no wallet code in capitals (read-only, 2026-10-17: 0 of 6), so no existing wallet changes | Fixed |
| F6-6 | 6 | External audit A3 | Nothing kept a wallet's balance inside the safe integer range the API reads it in: a refund on a wallet near $9 billion would make it unreadable | minor (needs billions) | `postJournal` refuses any journal that takes a wallet above `Number.MAX_SAFE_INTEGER` units; no cap on adjustments (S02 J6: none, owner 2026-10-07); db test | Fixed |
| F6-7 | 6 | External audit A4 | A credit did not wait for the wallet's lock: it could draw its write position before a debit holding the lock and commit after it, changing that debit's balance after on the timeline and its replay | major | `postJournal` locks every wallet a journal touches, credits too, before its postings draw their position; db test that holds the lock, starts a credit and checks the order (it fails without the fix: the credit's position came first) | Fixed |
| F6-8 | 6 | External audit A5 | A search by phone or email (`?q=`) was written to the API's logs in the URL and the query, and in the `Referer` the panel sends with each call; Sentry events carried it too (ADR 0008: logs scrub phone numbers) | major | pino serializers and Sentry's `beforeSend` replace the values of `q` in the URL, the query and the `Referer` (`core/http/secret-headers.ts`); the panel sends only its origin as the referrer (`<meta name="referrer" content="strict-origin">`); log test. The nginx access log of the panel still records the API URL with `q` (follow-up for the next deploy session: a log format without the query, checked against the fail2ban filters) | Fixed (app); nginx follow-up |
| F6-9 | 6 | External audit A6 | The store's balance chip and the buy box's balance did not read again after a refund, a reservation paid or an admin purchase on the customer's wallet | major | `isMoneyEvent` covers `order_refunded`, `order_partially_refunded`, `order_paid` and `order_placed_for_you`; unit test | Fixed |
| F6-10 | 6 | External audit A7 | On the store's wallet page an older answer could replace a newer balance, and a next page asked for before a live refresh was added to the new list, skipping entries | major | Each full read starts a generation; answers of an older read and next pages of a replaced list are dropped | Fixed |
| F6-11 | 6 | External audit A8 | In the panel, "انتقل إلى التعديل المرتبط" did nothing when the original sat on a page not loaded yet | minor | The link reads further pages until the row is there, then goes to it | Fixed |
| F6-12 | 6 | External audit A9 | The ledger summary read the customer totals and the system accounts in two statements: a write between them made the summary look unbalanced | minor | One statement, one snapshot | Fixed |
| F6-13 | 6 | External audit A10 | The wrong-session test did not cover a customer session on `/entries` and `/reverse` | minor | Both added, the reversal on a real adjustment | Fixed |
| F6-14 | 6 | Checking A1 | The store's purchase, cart, deposit and ticket keys follow the same rule (a new key once the body changed, `features/purchase/attempt.ts`, `deposits/deposit-form.tsx`, `deposits/usdt-form.tsx`, `support/new-ticket-page.tsx`, `support/ticket-page.tsx`): a lost answer then an edited retry can buy or open twice | major | One rule in `apps/store/src/lib/idempotency.ts`: after no answer, a server fault or `IDEMPOTENCY_KEY_REUSED` the key stays whatever the body until a success (the buy box and the cart keep that state in session storage across reloads; after a lost answer they free the key only on a refusal decided after the API looked the key up, `IDEMPOTENCY_KEY_REUSED` included, never on one answered before it such as the body's schema or the email check); a new key only for a changed body after a clear refusal. `errors.IDEMPOTENCY_KEY_REUSED` now says the first attempt was recorded and to check orders, deposits or tickets before retrying. Unit tests per helper, E2E for the edited purchase | Fixed (#122) |
| F7-1 | 7 | Writing the steps (production read, 2026-10-17) | None of the 223 code packs has a region or redemption instructions (CT8), while the region notes of several code games tell the customer the code arrives "مع خطوات الاستخدام": the buy box and the order page show instructions only when the pack has them, so a code buyer today gets the code with no steps | minor (content) | None yet: the owner decides, before feature 11's code purchase, whether to write the region and instructions per code pack (the pack dialog) or reword those region notes | Deferred to the catalog build-out (owner, 2026-10-17) |
| F7-3 | 7 | 7.6 step 2 | An image above 6 MB showed "حدث خطأ غير متوقع. أعد المحاولة بعد قليل." instead of the size limit: nginx refuses the body before the API (413 with its own HTML page, no API code), and the panel's `call()` read no code from it | minor | A 413 without an API code reads as `PAYLOAD_TOO_LARGE` ("الملف أكبر من 5 ميغابايت.") for every panel upload (`apps/admin/src/lib/api/client.ts`); unit test `client.test.ts`. The store's uploads check each file's size before sending, so nginx's limit is not reached there | Fixed |
| F7-4 | 7 | External audit A1 (GPT 6.1 sol, review only) | A pack edit and a purchase of that pack could deadlock: the edit locked the game `FOR UPDATE` then wrote the pack, while the purchase held the pack `FOR SHARE` and its order insert needed `FOR KEY SHARE` on the game (the foreign key). PostgreSQL broke the cycle by failing one of the two (no money lost: it rolled back) | major | Catalog game and category locks, and the reorder's row locks, are `FOR NO KEY UPDATE`, which a foreign key check does not wait on; catalog changes still queue on each other (`catalog.service.ts` `lockGame`, `lockCategory`; `catalog-records.ts` `rewriteOrder`). API test holding a purchase's locks against a pack edit (it deadlocked before the fix) | Fixed |
| F7-5 | 7 | External audit A2 | Moving a game to another category changed the margin rule in force for its packs without repricing them, and editing a select field's options could change a route's usability without repricing: the old price stayed until the next sync, and a pack below the new minimum margin read unavailable (`paused_by_margin_guard`) with no sync to fix a manual route | major | A move reprices the game's packs in its transaction (`rule_change`), a select field's new options reprice it (`route_change`), through one helper (`repriceGameProducts`, `catalog-records.ts`) also used by a field's archive and restore; API test: a move to a category with its own rule prices the pack at once | Fixed |
| F7-6 | 7 | External audit A3 | A move locked only its destination category, and read the game's category before locking the game: a reorder of the source category could rewrite the moved game's order after the move (duplicate order in the destination), and a move racing another move locked the wrong category | major | A move locks both categories in id order before the game; when the game moved between its first read and its lock, the change rolls back and runs again (`whileGameStays`); restore the same; API test: a move waits for its source category (it did not before the fix) | Fixed |
| F7-7 | 7 | External audit A4 | The panel read only the first 100 games of a category and sent them as the full list to reorder, and a reorder took at most 100 ids although categories and their games have no limit: a category of 101 games hid its last game and could not be reordered | major | The panel reads every page (`everyGame`, `catalog.queries.ts`); a reorder takes up to 1,000 ids (`MAX_REORDER_IDS`); the E2E mock pages as the API does; E2E with 101 games | Fixed |
| F7-8 | 7 | External audit A5 | Saving the game form while a new cover was uploading saved the old image and said "حُفظت التغييرات."; removing an image during an upload was undone when the upload landed. The supplier category import had the same gap | major | Saving (and the import) waits while an image uploads, and "إزالة" is disabled during it (`image-upload.tsx` `onPendingChange`, `game-form.tsx`, `import-category-sheet.tsx`) | Fixed |
| F7-9 | 7 | External audit A6 | Catalog names, labels, notes and instructions accepted invisible characters (direction overrides, U+2028/U+2029, zero-width): two names that look the same could both exist, and a pack name could show its digits in another order in the store, the panel and the audit log (F2-11, F2-15 for names) | minor | The catalog's text inputs refuse them (`catalog.ts` `line`, `paragraph`, `selectOptionInputSchema`); a stored option label keeps the older rule in answers and audit entries, so a row saved before (production holds none, read-only 2026-10-17) never breaks the store's game page or the field's repair (the reviewer's finding); supplier names and labels are cleaned of them before an import (`withoutHiddenText`); contracts tests per character, API test with such a label stored | Fixed |
| F7-10 | 7 | External audit A7 | Archiving an input field or a pack happened on one click, unlike a game or a category | minor | Both ask first, naming the record and what archiving does; a refusal (CT3) shows in the dialog (`fields-tab.tsx`, `products-tab.tsx`); E2E | Fixed |
| F7-11 | 7 | External audit A8 | The selected pack's outline used the game's accent in both themes, while CT6 checks the accent against the dark surface only: a pale accent (white passes at 14.78:1 on dark) left no visible selection in the light theme | minor | The light theme outlines with the accent only when it reaches 3:1 against white, else the primary color (`--game-accent-light`, `accentStyle`), and the selected pack carries a check mark, so the choice never rests on color alone (`pack-button.tsx`) | Fixed |
| F7-12 | 7 | External audit A9 | A pack card did not show its in-game amount (SF2): a name without it ("800 + 160 نقطة CP" for 960; 41 live packs on production) gave the customer no total | minor | The card shows "الكمية: 960" when the name does not already say the amount (`pack-amount.ts`, unit test) | Fixed |
| F7-13 | 7 | External audit A10 | The panel said a paused game's packs "تظهر للعملاء غير متوفرة", while a paused game is hidden everywhere on the store and its page is not found (SF1, case 7.5 step 6) | minor | "اللعبة متوقفة: لا تظهر هي ولا باقاتها في المتجر، وصفحتها لا تفتح، حتى تفعّلها."; step 7.5.4 updated | Fixed |
| F7-14 | 7 | External audit A11 | The test that the public image route refuses receipts and other private files used whatever QR image another test file had left, and skipped the check when there was none | minor | The test stores one file of every other kind itself and checks each, with and without a width (`catalog.test.ts`); the route itself was already right | Fixed |
| F7-15 | 7 | Review of the audit fixes | A game's move reprices its packs under the destination's rule as it reads it; a margin rule change on that destination at the same instant lists its products before the move commits, so the moved packs can keep the previous rule's price until the next repricing. The price stays above cost (the database check), and before F7-5 a move never repriced at all | minor | None: one admin, two of their own changes in the same second; the next sync, route change or rule change reprices | Accepted |
| F7-2 | 7 | Writing the steps (production read) | None of the 57 games has an ID guide image or an accent color, and no pack has an official price: the buy box shows no "where is my ID" guide for the 36 games that ask for an ID, every game uses the brand's sand, and no savings badge appears anywhere | minor (content) | None yet: the owner decides which games get an ID guide (first those whose ID customers most often get wrong) and whether to enter official prices, before the pilot | Deferred to the catalog build-out (owner, 2026-10-17) |

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
| PR | the steps (#115); the results and the first fixes (#116); the wallet-style QR and the external audit's fixes, F5-6 to F5-14 (#117), merged and deployed to production on 2026-10-17 (`c00576e`) |

---

## Feature 6 — Wallet and ledger (F03)

**What it covers:** the customer's wallet on the append-only double-entry ledger (S02, ADR 0003), checked against the real money of features 4 and 5: the balance as the sum of its movements (W2), the timeline with each deposit's label, reference, pounds and rate, and the running balance in write order (W3–W6), the SYP value rounded down (W9), the header chip (W8), a customer with no wallet yet (edge case 1), live updates (S05 NT7); the admin's side: the wallets search and the ledger summary (L1) with every system account the deposits created, a customer's wallet with its internal reasons, method and reference; adjustments (J1–J10): the categories per direction, the internal reason and the customer note, re-authentication, the typed confirmation above $100, the insufficient-balance refusal, a transaction number or TXID already claimed by a deposit or a manual deposit (J8, F4-3, F5-7), a double press; reversals (R1–R3); the adjustment email and notification (F27); the audit entries; who can read a wallet.

**How to read a case:** as in features 2 to 5: **What this checks** first, then the numbered steps; a line starting with "Expected" is what you must see.

**Real money in this feature:** none. TC1's balance must not change: it holds the real deposits for features 11–14. Every adjustment here is on **TC2** (a test customer), and TC2 ends the feature at **$0.00** with every adjustment reversed (case 6.12), so feature 22's reconciliation sees only books entries that cancel out.

**Worked numbers used below:** TC1's real credits, oldest first, as production recorded them in features 4 and 5 (read-only query, 2026-10-17; see F6-2):

| # | Entry | Label in the store | Credit | Balance after |
|---|---|---|---|---|
| 1 | Sham Cash `VD-D7SF9` | "إيداع شام كاش", "700 ل.س بسعر 140" | +$5.00 | $5.00 |
| 2 | Sham Cash A2 `VD-9SM7P` | "إيداع شام كاش", "700 ل.س بسعر 140" | +$5.00 | $10.00 |
| 3 | Sham Cash B `VD-V65JB` (1,000 declared, 700 received) | "إيداع شام كاش", "700 ل.س بسعر 140" | +$5.00 | $15.00 |
| 4 | USDT `VD-7ERCC`, 2.0036 received | "إيداع USDT (TRC20)" | +$2.00 | $17.00 |
| 5 | USDT `VD-9R7RS`, 3.0005 received | "إيداع USDT (BEP20)" | +$3.00 | $20.00 |
| 6 | USDT B `VD-7Q86J`, TXID pasted, 3.0004 received | "إيداع USDT (BEP20)" | +$3.00 | $23.00 |
| 7 | USDT C `VD-PQSVH` (4.0056 asked, 3.0056 received) | "إيداع USDT (BEP20)" | **+$3.00** | $26.00 |
| 8 | Manual deposit (5.8), USDT BEP20, the unmatched 2.9865 transfer | "تعديل الرصيد" with "إيداع مسجَّل يدوياً" | +$2.98 | **$28.98** |

Row 7: a USDT approval credits what arrived, floored to the cent (U15), so 3.0056 is $3.00 and 0.0056 goes to the rounding account. If TC1's wallet shows **+$4.00** for C, or a balance of $29.98, stop: log a blocker (a credit above what arrived).

The live check of 2026-10-14 (two USDT transfers, 1.5024 TRC20 `VD-GPC6H` and 3.0075 BEP20 `VD-AH2E7`) credited $1.50 and $3.00 to the owner's own account, which is **not** a test customer (F6-3): $4.50 under "للعملاء الحقيقيين". Two walk-in admin orders (2026-10-13 and 14, owner drawings, $0.99 each at a cost of $0.884) also posted to the books.

The books (S03 M2, S04 M1, S02 M1, S16; every journal balances per currency), as recorded before 6.5:

| System account | Code | Expected balance | Why |
|---|---|---|---|
| مقبوضات شام كاش | `sham_cash_receipts:SYP` | −2,100 ل.س | The three 700 ل.س received |
| صرف العملات | `currency_exchange:SYP` | +2,100 ل.س | The pounds converted |
| صرف العملات | `currency_exchange:USD` | −$15.00 | The dollars they became |
| مقبوضات USDT | `usdt_receipts:usdt_trc20` | −$3.5060 | 1.5024 (live check) + 2.0036 |
| مقبوضات USDT | `usdt_receipts:usdt_bep20` | −$12.0140 | 3.0075 (live check) + 3.0005 + 3.0004 + 3.0056 |
| كسور الإيداع | `deposit_rounding:USD` | +$0.0200 | 0.0024 + 0.0075 + 0.0036 + 0.0005 + 0.0004 + 0.0056 |
| التعديلات | `adjustments:manual_deposit` | −$2.98 | The manual deposit of 5.8: it posts against its category, so its USDT is not in `usdt_receipts` |
| — | `owner_drawings:USD` | −$1.98 | The two walk-in orders |
| — | `sales_revenue:USD` | +$1.98 | The same orders |
| — | `cost_of_goods:USD` | −$1.768 | Their supplier cost |
| — | `supplier_prepaid:wdgzone` | +$1.768 | The same cost |

The USD rows add up to −$33.48 and the customer wallets to +$33.48 ($28.98 + $4.50).

**Before you start**

- The panel open on the PC (signed in), the store as TC1 in a second browser, the store as TC2 in a private window (TC3 in case 6.2 only), TC2's inbox, and your phone.
- About 1 hour. Re-authentication lasts 5 minutes: cases 6.5 to 6.8 and 6.12 each do their saves in one sitting.
- "سعر الصرف" (`/rates`): 140, display step 1 ل.س.
- The exact USDT amounts, the live check's transfers and the account states were read from production for the owner (read-only, 2026-10-17) and are in the tables above.
- TC1: no deposit waiting, no order (purchases are feature 11). TC2: has never had a deposit or an adjustment (note its balance if it has). TC2's email preferences (`/account` → "الإشعارات") are all on.
- Nothing is paused in the store switches (feature 21).

**Not tested on production (by design):** 20 debits at once on one wallet, two first credits creating one account, two reversals or one idempotency key at the same instant, a debit racing a purchase (S02 money and concurrency tests); `UPDATE` or `DELETE` on ledger, adjustment and audit rows (database guard tests, for the app role and the owner); `test_funds` on a real customer (none exists before the pilot; the category is not offered for one, and an API test refuses it); a timeline longer than one page of 30 entries (TC1 has 8; paging is covered by the db and E2E tests); a reversal refused because the credit was spent (R4, needs a purchase). Purchases and refunds on the timeline are feature 11; the books against the real Sham Cash and USDT balances are feature 22.

### 6.1 TC1's balance is the sum of its movements

**What this checks:** the customer sees one number they can trust, and every dollar of it is explained by a movement they recognise.

1. In the store as TC1, the header. Expected: the balance chip with the wallet icon and `$28.98`; it opens "المحفظة".
2. "المحفظة". Expected: "رصيدك" `$28.98`; under it "≈ … ل.س" and "حسب سعر اليوم 140"; the buttons "إيداع" and "إيداعاتي".
3. Check the SYP value: $28.98 × 140 = 4,057.20 ل.س, rounded **down** to the step of 1. Expected: 4,057, never 4,058.
4. "الحركات", newest first. Expected: exactly the eight rows of the worked table, in reverse order: the label, the reference code (left to right), for the Sham Cash rows "700 ل.س بسعر 140" (B too: what was received, not the 1,000 declared), the date and time, the amount in the success colour with `+`, and "الرصيد بعدها" as in the table ($28.98 on the newest, $5.00 on the oldest). No row for the rejected, cancelled or expired deposits: only credits move money.
5. Add up the eight amounts yourself. Expected: $28.98, the balance of steps 1 and 2.
6. The manual deposit row (newest). Expected: "تعديل الرصيد" with "إيداع مسجَّل يدوياً", `+$2.98`; **no** TXID, internal reason or admin name (W6).
7. Reload the page, and open it on the phone. Expected: the same balance, order and running balances.

Result: ✅ (2026-10-17)

### 6.2 A customer with no wallet yet (TC3)

**What this checks:** a new customer sees a clear empty wallet, not an error.

1. As TC3 (private window; TC3 has never been credited). Expected: the header chip `$0.00`.
2. "المحفظة". Expected: "رصيدك" `$0.00`; "لا توجد حركات بعد" with the deposit button; no error.

Result: ✅ (2026-10-17)

### 6.3 The ledger summary and the system accounts

**What this checks:** the admin sees at a glance what the store owes its customers, and where the money behind each credit sits in the books.

1. In the panel open "المحافظ". Expected: "ما يدين به المتجر للعملاء" with "للعملاء الحقيقيين", "لعملاء الاختبار" and "محافظ برصيد".
2. Expected: "لعملاء الاختبار" $28.98 (TC1); "للعملاء الحقيقيين" $4.50 (the live check's customer, F6-3); "محافظ برصيد" 2.
3. Open "الحسابات النظامية". Expected: the eleven rows of the books table, each with its Arabic kind, its code (left to right) and its balance as in the table: `sham_cash_receipts:SYP` **−2,100 ل.س** and `currency_exchange:SYP` **2,100 ل.س** in pounds, not dollars (F6-1); the USDT and rounding rows with their four decimals.
4. Check that the books balance: the nine USD rows add up to −$33.48, and with step 2's two customer totals ($28.98 + $4.50) to exactly $0; the two SYP rows add up to 0 ل.س.

Result: ✅ (2026-10-17)

### 6.4 TC1's wallet in the panel

**What this checks:** the admin can explain every movement of a customer's wallet: which deposit, which transfer, who decided and why.

1. In "المحافظ" search the first 3 letters of TC1's name, then the start of TC1's email, then the start of TC1's phone. Expected: TC1 found each time, with "تجريبي" and $28.98. Search `ab`: "اكتب 3 أحرف على الأقل."; search `zzzq`: "لا نتائج".
2. Open TC1. Expected: name, email, phone, "تجريبي", the balance $28.98 and "≈ … ل.س بسعر 140" (the same SYP value as the store).
3. "الحركات": the eight rows of 6.1, each with the time, the label, the signed amount and "الرصيد بعدها" as in the store. Each deposit row links its reference code to the deposit's page: open A2 (`VD-9SM7P`) and USDT C (`VD-PQSVH`) from here (each opens the right deposit), then come back.
4. The manual deposit row. Expected: "إيداع مسجَّل يدوياً", "USDT (BEP20)" with 5.8's TXID (left to right, in full on hover; copy it for 6.8), your internal reason of 5.8 under "السبب الداخلي" with "بواسطة <your name>", and the action "عكس". **Do not press it.**
5. Expected: no "عكس" on the deposit rows (a deposit is never reversed from the wallet; a correction is an adjustment).

Result: ✅ (2026-10-17)

### 6.5 An adjustment, its email and the customer's view (TC2)

**What this checks:** money moved by hand is always explained inside (a reason the customer never sees), confirmed by the admin's identity, recorded once, and shown to the customer at once with an email.

1. As TC2 (private window), keep "المحفظة" open: `$0.00`, "لا توجد حركات بعد".
2. In the panel open TC2's wallet → "تعديل الرصيد". Expected: "يُسجَّل التعديل في سجل التدقيق، ويصل إلى العميل بريد به."; "الاتجاه" إضافة / خصم; "الفئة"; "السبب الداخلي" with "لا يراه العميل. يُحفظ في سجل التدقيق."; "ملاحظة للعميل (اختيارية)" with "يظهر للعميل في حركات محفظته."; "الرصيد الحالي" $0.00.
3. "إضافة", open "الفئة". Expected: "تعويض", "تصحيح خطأ", "إيداع مسجَّل يدوياً", "رصيد تجريبي" (TC2 is a test customer); no "استرداد نقدي". Switch to "خصم": "تصحيح خطأ", "استرداد نقدي", "رصيد تجريبي" only.
4. "إضافة", amount `10.555`. Expected: "اكتب مبلغًا أكبر من صفر بخانتين عشريتين على الأكثر." Amount `10`, "رصيد تجريبي", reason `abc`. Expected: "اكتب سببًا من 5 إلى 500 حرف."
5. Reason `System test 6.5: test funds`, customer note `رصيد تجريبي لاختبار المحفظة`. Expected: "الرصيد بعد التعديل" $10.00. Press "سجّل التعديل" **twice quickly**. Expected: the re-authentication dialog (password and TOTP), then the dialog closes; TC2's timeline shows **one** row `+$10.00` "رصيد تجريبي" with your note, the reason with "بواسطة <your name>", balance after $10.00.
6. TC2's window, without reloading. Expected: the chip and "رصيدك" turn to `$10.00`; "الحركات": "تعديل الرصيد" with "رصيد تجريبي", the note on a second line, `+$10.00`, "الرصيد بعدها" $10.00; **no** internal reason or admin name. The bell: "أضافت الإدارة $10.00 إلى رصيدك: رصيد تجريبي."
7. TC2's inbox: **one** email "أُضيف $10.00 إلى رصيدك" with "نوع الحركة: رصيد تجريبي." and "عرض المحفظة" (it opens `/wallet`). Expected: no reason, no note, no admin name.

Result: ✅ (2026-10-17)

### 6.6 A debit cannot go below zero

**What this checks:** the store never lets a wallet go negative, whoever moves the money, and tells the admin why.

1. TC2's wallet → "تعديل الرصيد": "خصم", `25`, "استرداد نقدي", reason `System test 6.6: debit over the balance`. Expected: "الرصيد بعد التعديل" shows −$15.00 before you send. Press "سجّل التعديل" (re-authenticate if asked).
2. Expected: refused with "الرصيد الحالي $10.00 لا يكفي لهذا الخصم. خفّض المبلغ أو راجع الحركات."; TC2 still $10.00, no new row, no email.
3. Change to `4`, "رصيد تجريبي", reason `System test 6.6: test funds debit`, no note; save. Expected: a row `−$4.00`, balance after $6.00; in TC2's window, live, a neutral `−$4.00` row, the bell "خصمت الإدارة $4.00 من رصيدك: رصيد تجريبي.", and the email "خُصم $4.00 من رصيدك".

Result: ✅ (2026-10-17)

### 6.7 Above $100: the amount typed twice, then reversed

**What this checks:** a slip of the finger (1000 for 10) cannot reach a wallet unnoticed, and a mistake is undone by a new entry, never by editing the old one.

Do steps 1–6 in one sitting.

1. TC2's wallet → "تعديل الرصيد": "إضافة", `150`, "تعويض", reason `System test 6.7: amount confirmation`. Expected: "أعد كتابة المبلغ" appears with "المبلغ أكبر من 100 دولار: اكتبه مرة ثانية للتأكيد، دون لصق."; pasting into it does nothing.
2. Type `15` in it and save. Expected: "المبلغان غير متطابقين. اكتب المبلغ نفسه مرة ثانية."; nothing recorded.
3. Type `150` and save. Expected: `+$150.00` "تعويض", balance after $156.00; TC2's email "أُضيف $150.00 إلى رصيدك".
4. Open TC2's wallet in a second panel tab. In the first, press "عكس" on the $150.00 row. Expected: "عكس التعديل" with "يُسجَّل تعديل معاكس بالمبلغ والفئة نفسيهما. لا يُعكس التعديل إلا مرة واحدة.", "التعديل الأصلي" (إضافة, $150.00, تعويض, its date), the balance after $6.00, the reason and note fields, and "أعد كتابة المبلغ" (above $100).
5. Reason `System test 6.7: reversal`, confirmation `150`, "اعكس التعديل". Expected: a row "عكس: تعويض" `−$150.00`, balance after $6.00; the original shows "معكوس" and the reversal "يعكس تعديلًا سابقًا", each leading to the other ("انتقل إلى التعديل المرتبط"); "عكس" is gone from both. TC2 sees "عكس: تعويض" `−$150.00`, the bell, and the email "خُصم $150.00 من رصيدك" with "نوع الحركة: عكس: تعويض.".
6. In the second tab (still showing "عكس" on the $150.00 row) reverse it again. Expected: "عُكس هذا التعديل من قبل."; TC2 still $6.00.

Result: ✅ (2026-10-17)

### 6.8 A transaction number or TXID already credited cannot be recorded again

**What this checks:** the same real payment can never be credited twice by mixing a deposit and a manual deposit, whatever its spelling or network (J8, F4-3, F5-7).

No money: **every save in this case must be refused.** If one is accepted, stop: log a blocker, and reverse that adjustment at once (its reference stays claimed, R5).

1. TC2's wallet → "تعديل الرصيد": "إضافة", `1`, "إيداع مسجَّل يدوياً". Expected: "طريقة الدفع" and "رقم العملية أو TXID" appear.
2. "شام كاش", A2's Sham Cash transaction number (4.5b), reason `System test 6.8: claimed reference`; save (re-authentication). Expected: "هذا الرقم المرجعي مسجَّل من قبل لهذه الطريقة."; TC2 still $6.00.
3. The same number with Arabic-Indic digits (٠–٩) for its digits, then with a space in the middle. Expected: the same refusal each time.
4. "USDT (BEP20)", B's TXID from 5.4 (deposit `VD-7Q86J`). Expected: the same refusal.
5. "USDT (TRC20)", the TXID of 5.8 (a BEP20 transfer, recorded as a BEP20 manual deposit). Expected: the same refusal (a TXID is one claim across both networks, F5-7).
6. "USDT (BEP20)", the same TXID in capitals with its `0x` removed. Expected: the same refusal.
7. TC2: no new row, no email, balance $6.00.

Result: ✅ (2026-10-17)

### 6.9 Only the customer reads their wallet, and only the admin changes it

**What this checks:** a wallet is readable by its customer and the admin only, and only the admin can change it.

1. In TC1's browser open `https://digital.vertexmedia.pro/api/wallet`. Expected: TC1's balance only (`balanceUnits` 28980000). Open `https://digital.vertexmedia.pro/api/wallet/entries`: TC1's eight entries, with no reason, admin or journal field.
2. In TC2's window open the same two addresses. Expected: TC2's own balance and entries, nothing of TC1's.
3. Signed out (a new private window), open `https://digital.vertexmedia.pro/api/wallet`. Expected: 401. Open `https://digital.vertexmedia.pro/wallet`: the sign-in page; after signing in as TC2, back on the wallet.
4. In TC1's browser open `https://digital-admin.vertexmedia.pro/api/admin/wallets/<TC1's id>` (the id from the panel's address bar) and `https://digital-admin.vertexmedia.pro/api/admin/ledger/summary`. Expected: 401, no data. Open `https://digital.vertexmedia.pro/api/admin/ledger/summary`: 404.
5. Optional, in the browser's developer tools (Network): the answer of `/api/wallet` carries `Cache-Control: no-store`.

Result: ✅ (2026-10-17)

### 6.10 The audit log has every adjustment

**What this checks:** every dollar moved by hand can be traced to who moved it, when, why and with what result.

1. In "سجل التدقيق" filter the entity type "تعديل رصيد".
2. Expected, newest first: the reversal of 6.7 ("عكس تعديل رصيد"), the $150.00 compensation, the $4.00 debit of 6.6, the $10.00 credit of 6.5 (each "تعديل رصيد عميل"), and the $2.98 manual deposit of 5.8; actor you, channel admin. **Nothing** for the second press of 6.5, the refusals of 6.5 to 6.8, or the second reversal of 6.7.
3. Open the reversal. Expected: labelled customer, direction, amount $150.00, category, "التعديل المعكوس" (the $150.00 adjustment), the journal, the balance after $6.00, and your reason.
4. Open the $10.00 credit. Expected: the customer note and the reason; balance after $10.00.

Result: ✅ (2026-10-17)

### 6.11 Screens and emails quality on desktop and phone

**What this checks:** a customer on a phone and the admin on either device read a wallet without guessing.

1. On the phone as TC1 and TC2, in both themes: the header chip, "المحفظة" with its SYP line, the timeline (deposit rows with codes and pounds, adjustment rows with notes, a reversal, a debit), and TC3's empty wallet. Expected: readable, RTL, Latin digits, codes and amounts left to right, credits in the success colour with `+` and debits neutral with `−`, no horizontal scroll.
2. On the PC, the panel in the light and dark themes: "المحافظ" with the summary and the system accounts, the search results, TC1's and TC2's wallets, the adjust dialog (with the confirmation field) and the reverse dialog. On the phone: the wallets search and a wallet usable, the timeline table scrolling within its frame.
3. The adjustment emails of 6.5–6.7: the brand header, Arabic RTL, the right amount and category, "عرض المحفظة" working, nothing internal.

Result: ✅ (2026-10-17)

### 6.12 Clean-up: TC2 back to $0.00

**What this checks:** test money leaves by entries that cancel it, so the books show it came and went.

1. TC2's wallet: reverse the $4.00 debit of 6.6 (reason `System test 6.12: clean-up`). Expected: "عكس: رصيد تجريبي" `+$4.00`, balance $10.00.
2. Reverse the $10.00 credit of 6.5 (same reason). Expected: "عكس: رصيد تجريبي" `−$10.00`, balance **$0.00**; "عكس" offered on no TC2 row.
3. "المحافظ": "لعملاء الاختبار" back to $28.98 as in 6.3; `adjustments:test_funds` and `adjustments:compensation` at $0.00 in "الحسابات النظامية".
4. TC1: still $28.98 with its eight rows.

Result: ✅ (2026-10-17)

### Feature 6 sign-off

| Item | Value |
|---|---|
| Cases passed | 12 of 12 |
| Findings | F6-1 (found while writing the steps, fixed in #120 and deployed to production on 2026-10-17, `d5cad4d`, before 6.3 was run); F6-2 (the worked numbers rewritten from the production records before 6.1); F6-3 open (the live check's customer is not a test customer; decide in feature 16); F6-4 to F6-13 from an external audit by another model (GPT 6.1 sol, review only), each confirmed in the code and fixed: one blocker (F6-4, a lost answer then an edited retry adjusting twice), five major, four minor; F6-14 (the store's keys, found while checking A1) fixed in #122 |
| Accepted by the owner on | 2026-10-17; the audit fixes accepted by Claude on 2026-10-17 (every check green, the reviewer's findings closed) |
| PR | the steps (#119); the F6-1 fix (#120); the store's keys, F6-14 (#122); the results, the corrected numbers and the external audit's fixes, F6-4 to F6-13 (#123); #122 and #123 merged and deployed to production on 2026-10-17 (`0e7de6b`) |

## Feature 7 — Catalog (F08)

**What it covers:** what the store sells (S06 CT1–CT10, ADR 0020), first as it stands on production, then on two test games: the categories with their order, rename and archive (CT2, CT5); a game's data, its slug fixed at creation and unique even once archived, new games paused, activation only when complete (CT3); the cover and ID guide uploads re-encoded to WebP and the public image route (CT10); the accent color and its contrast against the dark surface and white (CT6); input fields with their key and type fixed (CT7); packs of both kinds with their defaults, and region and redemption instructions for codes (CT8); pause, resume, reorder, archive and restore at each level (CT1, CT4, CT5); the availability the panel shows and what customers see (CT9, S09 SF1); the audit entries; who can change the catalog.

**How to read a case:** as in features 2 to 6: **What this checks** first, then the numbered steps; a line starting with "Expected" is what you must see.

**Real money in this feature:** none. No purchase, no supplier call, no price change. The real catalog is only **read**: every create, edit, pause, reorder and archive is on a test category and its two test games, which end the feature archived (case 7.14). Never press "شراء", "المسارات" or "تفعيل الكل" here (features 9 and 14), and never pause, edit or archive a real game or pack.

**Worked numbers used below:** the production catalog as recorded (read-only query, 2026-10-17, deployed `0e7de6b`):

| # | Category | Slug | Games (unarchived) |
|---|---|---|---|
| 1 | ألعاب الموبايل | `games` | 21 |
| 2 | ألعاب الورق والتسلية | `card-board-games` | 5 |
| 3 | تطبيقات الدردشة والبث المباشر | `apps` | 11 |
| 4 | بطاقات الألعاب والمنصات | `gaming-cards` | 10 |
| 5 | بطاقات المتاجر الرقمية | `gift-cards` | 3 |
| 6 | الاشتراكات والخدمات الرقمية | `subscriptions` | 7 |

- **57 games**, all active, none archived. Each has a cover (57 distinct `catalog_image` files, 61 uploaded in all); **none** has an ID guide image or an accent color (F7-2).
- **587 unarchived packs**: 364 direct (133 active, 231 paused) and 223 code (39 active, 184 paused); 18 archived, all in PUBG Mobile. Every direct pack has a maximum quantity of 1, every code pack 10. **No pack** has an official price, and **no code pack** has a region or redemption instructions (F7-1). No game mixes the two kinds.
- **41 input fields**, all required, none archived: 31 games have one (`digits` 1–32 or `text` 1–64), 5 have two (Mobile Legends `player_id` + `server_id`; Genshin Impact, Honkai: Star Rail and Zenless Zone Zero `player_id` + a `select` "السيرفر" of 4 options; Solo Leveling: Arise `user_id` + a text "السيرفر"), and the 21 games with code packs only have none. Telegram's field is the only one with help text; it and CapCut Pro's have bounds of their own (5–33 and 3–64).
- **7 games have no active pack** (Fortnite, Chamet, Spotify, Netflix, Valorant, CapCut Pro, Yalla): every pack paused, so the store shows them unavailable.
- **PUBG Mobile** (`pubg-mobile`, first in ألعاب الموبايل): one field `player_id` "معرّف اللاعب" (digits, 1–32, required); 8 search terms; **29** live packs in this order: 60 شدة, 325 شدة, 660 شدة, 1,800 شدة, 3,850 شدة, 8,100 شدة, then the Prime and Prime Plus months, the Royale Pass packs, the bundles, the two weekly offers and the six WOW coin packs; **14 active, 15 paused**. Its **18 archived** packs are the "Fast ·", "Manual ·" and "Reserve ·" UC packs of 2026-10-15. At the time of writing "60 شدة" sells at **$0.99** (≈ 139 ل.س at 140, rounded up) and "325 شدة" at **$4.88** (≈ 684 ل.س); "660 شدة" is paused, with no price.
- The audit log holds the catalog's build of 2026-10-13 to 15: 57 "إضافة لعبة", 605 "إضافة باقة", 41 "إضافة حقل إدخال", 18 "أرشفة باقة", 3 "إضافة فئة" and 3 "تعديل فئة" (the seeds renamed), and the reorders.

The contrast ratios of 7.6 (WCAG 2, rounded down to 2 decimals, `contrastRatio`): `#2E7D6A` 2.99:1 against the dark surface `#0B2D28` (refused); `#2E7D6B` exactly **3:1** (accepted, the boundary) and 4.92:1 against white; `#F2A900` 7.35:1 against the dark surface and **2:1** against white (the light-theme warning).

The test records (all archived at the end; their slugs can never be used again):

| Record | Arabic name | English name | Slug |
|---|---|---|---|
| Test category | اختبار النظام | — | `system-test` |
| Game A (direct packs) | لعبة اختبار 7 | System Test 7 | `system-test-7` |
| Game B (a code pack) | تطبيق اختبار 7 | System Test 7 App | `system-test-7-app` |

**Before you start**

- The panel open on the PC (signed in), the store as TC1 in a second browser, a private window signed out, and your phone.
- About 1 hour 30 minutes. Game A is **active and visible to every store visitor** only between steps 1 and 5 of case 7.8: do those steps in one sitting, in a few minutes.
- On the PC: two images that are not receipts or personal data (a screenshot wider than 1600 px, e.g. 1920 × 1080, for the cover; any PNG or JPEG for the ID guide), a text file renamed to `fake.png`, and an image between 5 and 6 MB (or any photo above 5 MB).
- "سعر الصرف" (`/rates`): 140. Nothing is paused in the store switches (feature 21).
- If the panel shows other counts than the worked numbers (a game or pack added, paused or archived since 2026-10-17), note the difference here and use what the panel shows.

**Not tested on production (by design):** two tabs saving one game, two reorders, or two creations with one name at the same instant (S06 concurrency tests); a decompression bomb, a 25-megapixel image and metadata stripping (`files` tests); the limits of 10 fields and 100 packs per game (`CATALOG_LIMIT_REACHED`, API tests); a reorder sent with a stale list (API test, edge case 2); a field's values checked at purchase, the pack's quantity limit, the ID guide in the buy box and the redemption text on a code order (features 10 to 13). Supplier offers, routes, stock, "تفعيل الكل" and availability from a route are feature 9 (the 18 archived PUBG packs still hold their routes: checked there); margins, prices and the "التسعير" tab are feature 8; the store's home, game pages and search are feature 10.

### 7.1 The catalog in the panel as it stands

**What this checks:** the admin sees the whole catalog in the order customers see it, and can find any game in seconds.

1. In the panel open "الكتالوج" (`/catalog`). Expected: "الكتالوج" with "الفئات والألعاب والتطبيقات، وحقول إدخالها وباقاتها."; "إدارة الفئات" and "إضافة لعبة"; the six category tabs in the order of the worked table, "ألعاب الموبايل" chosen.
2. Expected: the 21 games of ألعاب الموبايل as cards in order (ببجي موبايل first, ستيت أوف سرفايفل last), each with its cover, Arabic and English names, "نشطة" and "الباقات: <n>": ببجي موبايل **"الباقات: 29"** (unarchived packs only, not 47), فري فاير "الباقات: 5", موبايل ليجندز "الباقات: 29".
3. Open each other tab. Expected: 5, 11, 10, 3 and 7 games; Fortnite (بطاقات الألعاب والمنصات) still reads "نشطة" with "الباقات: 9" (its packs are paused, not the game).
4. In ألعاب الموبايل search `pubg`, then `ببجي`. Expected: ببجي موبايل and ببجي نيو ستيت each time. Search `zzzq`: "لا توجد ألعاب تطابق هذا البحث".
5. Clear the search. "الحالة" → "متوقفة": no game (all 21 are active). "الأرشيف" → "المؤرشفة": no game. Back to "كل الحالات" and "غير المؤرشفة".
6. "إدارة الفئات". Expected: the six categories in order, each with "الألعاب: <n>" as in the worked table; its archived tab "لا توجد فئات مؤرشفة.". Close it.

Result: ✅ (2026-10-17)

### 7.2 PUBG Mobile in the panel, read only

**What this checks:** one real game shows everything the store sells under it, and its current state, without opening the database.

Read only: **change nothing** in this case.

1. Open ببجي موبايل. Expected: the header "ببجي موبايل" with "نشطة" and `PUBG Mobile` (left to right); "العودة إلى الكتالوج" and "أرشفة" (**do not press it**); the tabs "البيانات", "حقول الإدخال", "الباقات", "التسعير".
2. "البيانات". Expected: the names; "العنوان (slug)" `pubg-mobile`, read-only, with "هذا عنوان صفحة اللعبة في المتجر، ولا يتغيّر بعد إنشائها."; the category; the cover with its size in pixels; "صورة دليل المعرّف" empty (F7-2); "لون التمييز" empty; the region notes; 8 search terms; "نشطة في المتجر" on, with "اللعبة ظاهرة للعملاء، وكل باقة نشطة فيها تُعرض.".
3. "حقول الإدخال". Expected: one row "معرّف اللاعب", `player_id`, "أرقام", "إلزامي". Its archived tab: "لا توجد حقول مؤرشفة".
4. "الباقات". Expected: the 29 packs in the order of the worked numbers, each "شحن مباشر" with its amount, no official price, max quantity 1, and its status (14 "نشطة", 15 "متوقفة"): "60 شدة" "متوفرة" with $0.99; "660 شدة" "غير متوفرة: متوقفة" with "لا سعر بعد".
5. The packs' archived filter. Expected: the 18 "Fast ·", "Manual ·" and "Reserve ·" packs, each with "استعادة" (**do not press it**).

Result: ✅ (2026-10-17)

### 7.3 What customers see of the real catalog

**What this checks:** the store shows only what is active, in the panel's order, and a paused pack never looks buyable.

1. In the private window (signed out) open `https://digital.vertexmedia.pro`. Expected: the six categories in the panel's order, with their games in the panel's order.
2. Open ببجي موبايل. Expected: the field "معرّف اللاعب" and the 29 packs in the panel's order: the 14 active ones with a price ("60 شدة" $0.99, ≈ 139 ل.س); the 15 paused ones greyed out in place with "غير متوفرة حاليًا", no price and no buy action; none of the 18 archived packs.
3. Open فورتنايت (every pack paused). Expected: the page opens, every pack greyed "غير متوفرة حاليًا"; on the home page its card reads "غير متوفرة حاليًا".
4. Open `https://digital.vertexmedia.pro/games/system-test-7`. Expected: the not-found page (the game does not exist yet; 7.5 opens the same address once it exists, paused).

Result: ✅ (2026-10-17)

### 7.4 Categories: add, refuse, rename, reorder

**What this checks:** the admin shapes the store's sections, and a page address or a name can never be taken twice.

1. "إدارة الفئات" → "فئة جديدة": name `اختبار النظام`, slug `System Test`; "إضافة الفئة". Expected: under the slug "العنوان من 2 إلى 48 حرفًا: أحرف لاتينية صغيرة وأرقام وشرطات بين الكلمات، مثل pubg-mobile."; nothing added.
2. Slug `games`. Expected: "هذا العنوان (slug) مستخدم من قبل، ولو في سجل مؤرشف. اختر عنوانًا آخر.". Slug `system-test` with the name `ألعاب الموبايل`: "يوجد عنصر آخر بهذا الاسم في المكان نفسه. اختر اسمًا آخر.".
3. Name `اختبار النظام`, slug `system-test`. Expected: added **last** (7th) with "الألعاب: 0"; the catalog shows a seventh tab.
4. Rename it `اختبار النظام 7` ("إعادة تسمية", "حفظ"), then back to `اختبار النظام`. Expected: the name changes in the dialog and the tab each time.
5. "تحريك اختبار النظام للأعلى". Expected: it is 6th, الاشتراكات والخدمات الرقمية 7th. "تحريك اختبار النظام للأسفل": back to 7th, the six real categories in their order.
6. The store's home page (reload). Expected: no "اختبار النظام" section (a category with no active game is not shown).

Result: ✅ (2026-10-17)

### 7.5 A new game starts paused and cannot go live incomplete

**What this checks:** nothing half-built reaches customers: a new game stays hidden until it has what a customer needs.

1. In the "اختبار النظام" tab press "إضافة لعبة". Expected: "لعبة أو تطبيق جديد" with "تبدأ اللعبة متوقفة حتى تكتمل بياناتها وتفعّلها."; the category "اختبار النظام" chosen; under the slug "عنوان الصفحة في المتجر، ولا يتغيّر بعد الحفظ: أحرف لاتينية صغيرة وأرقام وشرطات."; "تُنشأ اللعبة متوقفة. فعّلها بعد رفع صورة الغلاف وإضافة حقل إدخال مطلوب إن كانت لها باقات شحن مباشر.".
2. Arabic name `لعبة اختبار 7`, English name `لعبة`, slug `system-test-7`; "إنشاء اللعبة". Expected: "اكتب الاسم بالإنجليزية بأحرف لاتينية، حتى 60 حرفًا."; nothing created.
3. English name `System Test 7`, slug `pubg-mobile`. Expected: the `SLUG_TAKEN` text of 7.4. Arabic name `ببجي موبايل` with slug `system-test-7`: the `NAME_TAKEN` text.
4. Arabic name `لعبة اختبار 7`, slug `system-test-7`, no images; create. Expected: the page of game **A**, "لعبة اختبار 7" with "متوقفة"; the slug read-only; "نشطة في المتجر" off with "اللعبة متوقفة: لا تظهر هي ولا باقاتها في المتجر، وصفحتها لا تفتح، حتى تفعّلها." (F7-13; before it read "باقاتها تظهر للعملاء غير متوفرة.").
5. Turn "نشطة في المتجر" on. Expected: refused, "ينقصها: صورة الغلاف"; still "متوقفة".
6. Open `https://digital.vertexmedia.pro/games/system-test-7` (private window). Expected: the not-found page (a paused game is shown nowhere on the store, SF1).
7. Back in the catalog, "اختبار النظام": A's card with "متوقفة" and "الباقات: 0". Create game **B** the same way: `تطبيق اختبار 7`, `System Test 7 App`, `system-test-7-app`. Expected: B after A, "متوقفة".

Result: ✅ (2026-10-17)

### 7.6 Images and the accent color

**What this checks:** the store's images are always safe, light WebP files, and a game's color stays readable on the store's dark surface.

1. A → "البيانات" → "صورة الغلاف" → "رفع صورة": `fake.png` (choose "All files" in the file dialog if needed). Expected: "الملف ليس صورة صالحة. ارفع صورة PNG أو JPEG أو WebP حتى 5 ميغابايت و25 ميغابكسل."; no preview.
2. The image above 5 MB. Expected: "الملف أكبر من 5 ميغابايت." (a file above 6 MB is stopped by nginx before the API: note the text you see; until F7-3 it read "حدث خطأ غير متوقع. أعد المحاولة بعد قليل.").
3. The wide screenshot. Expected: "جارٍ الرفع…", then its preview and its size fitted within 1600 px ("1600 × 900 بكسل" for 1920 × 1080), with "استبدال الصورة" and "إزالة". "صورة دليل المعرّف": the other image, its preview and size.
4. "لون التمييز" `#2E7D6A`. Expected, as you type: "التباين مع الخلفية الداكنة 2.99:1، أقل من 3:1 ولن يُقبل.". "حفظ التغييرات": refused with "تباين اللون مع الخلفية الداكنة 2.99:1، والحد الأدنى 3:1. اختر لونًا أفتح."; both images still in the form.
5. `#2e7d6b` (lower case). Expected: "التباين مع الخلفية الداكنة 3:1، مقبول." and "التباين مع الأبيض 4.92:1."; save: "حُفظت التغييرات."; reload: the color reads `#2E7D6B` (stored upper case), both images kept.
6. `#F2A900`. Expected: "التباين مع الخلفية الداكنة 7.35:1، مقبول." and "التباين مع الأبيض 2:1، أقل من 3:1: سيظهر في الوضع الفاتح شريطًا بلا نص."; save.
7. Open the cover preview in a new tab (right-click → open image). Expected: `https://digital-admin.vertexmedia.pro/api/catalog/images/<id>` shows the image. The same path on `https://digital.vertexmedia.pro`: the same image. Optional (developer tools, Network): `Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`.
8. Change the last character of the id in that address (still 36 characters). Expected: 404.

Result: ✅ (2026-10-17)

### 7.7 Input fields

**What this checks:** a direct top-up cannot go live without the player ID it needs, and the fields that orders and suppliers refer to never change under them.

1. A → "الباقات" → "إضافة باقة": "شحن مباشر", name `60 UC`, amount `60`; "إضافة الباقة". Expected: the pack listed, "نشطة", max quantity 1, "غير متوفرة: متوقفة" (the game is paused).
2. "البيانات": turn "نشطة في المتجر" on. Expected: refused, "ينقصها: حقل إدخال مطلوب".
3. "حقول الإدخال". Expected: "أضف حقل معرّف اللاعب قبل تفعيل باقات الشحن المباشر". "إضافة حقل": key `Player-ID`. Expected: "المفتاح من 2 إلى 32 حرفًا: يبدأ بحرف لاتيني صغير، ثم أحرف وأرقام وشرطة سفلية.".
4. Key `player_id`, type "أرقام", label `معرّف اللاعب`, help `ستجده في ملفك الشخصي داخل اللعبة.`, min `15`, max `5`, "إلزامي". Expected: "الحدود أرقام صحيحة ضمن المسموح، وأقل طول لا يتجاوز أقصاه.". Min `5`, max `15`; "إضافة الحقل". Expected: the row "معرّف اللاعب", `player_id`, "أرقام", "إلزامي".
5. "إضافة حقل": key `player_id`, type "نص", label `معرّف آخر`. Expected: "لهذه اللعبة حقل بهذا المفتاح من قبل، ولو مؤرشفًا. اختر مفتاحًا آخر.".
6. Key `server`, type "قائمة خيارات", label `السيرفر`, "اختياري", one option `eu` "أوروبا". Expected: "من 2 إلى 50 خيارًا، لكل خيار قيمة لاتينية فريدة واسم.". Add a second option `eu` "آسيا": the same refusal. Change its value to `asia`; add. Expected: the row "السيرفر", `server`, "قائمة خيارات", "اختياري", after "معرّف اللاعب".
7. Edit "السيرفر". Expected: "تعديل حقل الإدخال" with "المفتاح والنوع ثابتان بعد الإنشاء."; the key and type cannot be changed. Change its label to `المنطقة`, save: the row reads "المنطقة".
8. Move "المنطقة" up, then down. Expected: first, then back after "معرّف اللاعب".

Result: ✅ (2026-10-17)

### 7.8 Going live, and back

**What this checks:** a complete game reaches customers at once and leaves at once when paused, and an active game can never lose its required field.

Do steps 1–5 in one sitting: game A is visible to every store visitor between steps 1 and 5.

1. A → "البيانات": turn "نشطة في المتجر" on. Expected: "نشطة", with "اللعبة ظاهرة للعملاء، وكل باقة نشطة فيها تُعرض."; in "الباقات", `60 UC` "غير متوفرة: لا مسار صالح" (no supplier route, feature 9).
2. The store's home page in the private window (reload; allow up to a minute). Expected: a last section "اختبار النظام" with "لعبة اختبار 7", its cover and "غير متوفرة حاليًا". Open it (`/games/system-test-7`): the fields "معرّف اللاعب" (with its help text) and "المنطقة" (with "أوروبا" and "آسيا"), and `60 UC` greyed "غير متوفرة حاليًا", no price, no buy action.
3. In the panel, A → "حقول الإدخال": archive "معرّف اللاعب" (since F7-10 it asks first: confirm "أرشفة"). Expected: refused, "ينقصها: حقل إدخال مطلوب" (the last required field of an active game with a direct pack, CT3); the field still listed.
4. A → "البيانات": turn "نشطة في المتجر" off. Expected: "متوقفة" at once.
5. The store (reload; allow up to a minute). Expected: no "اختبار النظام" section; `/games/system-test-7` the not-found page.
6. A → "حقول الإدخال": archive "معرّف اللاعب" now that A is paused. Expected: accepted; the list shows only "المنطقة", the archived tab "معرّف اللاعب". Restore it: back in the list.

Result: ✅ (2026-10-17)

### 7.9 Packs of both kinds

**What this checks:** each pack carries what the customer needs to choose it and, for a code, to use it; a pack's kind never changes once created.

1. A → "الباقات" → "إضافة باقة": name `60 UC`. Expected: "يوجد عنصر آخر بهذا الاسم في المكان نفسه. اختر اسمًا آخر.". Name `325 UC`, amount `0`: "الكمية رقم صحيح أكبر من صفر.". Amount `325`, official price `0.995`: "السعر بالدولار بسنتات كاملة، مثل 0.99، حتى 10000.". Official price `4.99`, max quantity `51`: "أقصى كمية من 1 إلى 50.". Max quantity `1`; add. Expected: `325 UC` with the official price $4.99, last.
2. Add `660 UC` (amount 660, no official price). Expected: `60 UC`, `325 UC`, `660 UC` in that order.
3. Edit `325 UC`. Expected: "تعديل الباقة" with "نوع الباقة ثابت بعد الإنشاء."; the kind cannot be changed; no region or instructions fields. Close it.
4. Move `660 UC` up twice. Expected: `660 UC`, `60 UC`, `325 UC`. Down twice: back to `60 UC`, `325 UC`, `660 UC`.
5. "إيقاف" on `325 UC`. Expected: "متوقفة", "غير متوفرة: متوقفة"; "استئناف" brings back "نشطة". Pause it again and leave it paused.
6. B → "الباقات" → "إضافة باقة": "كود". Expected: "يستلم العميل كودًا يستخدمه بنفسه."; the max quantity turns to **10** by itself; "المنطقة" and "تعليمات الاستخدام" (with "نص عادي حتى 2000 حرف، تظهر للعميل مع الكود.") appear. Name `بطاقة 10$`, amount `10`, region `الولايات المتحدة`, instructions `افتح المتجر واختر استبدال بطاقة.` and, on a second line, `الصق الكود ثم أكّد.`; add. Expected: "كود", max quantity 10.
7. Edit it. Expected: the region and both lines of the instructions as typed (plain text, the line break kept). Close it.
8. B → "البيانات": turn "نشطة في المتجر" on. Expected: refused, "ينقصها: صورة الغلاف" only (a game with code packs only needs no input field). Leave B paused.

Result: ✅ (2026-10-17)

### 7.10 Archive and restore

**What this checks:** nothing in the catalog is ever deleted: an archived item leaves the store and comes back exactly as it was, and never into a place that no longer exists.

1. A → "الباقات": archive `660 UC` (since F7-10 it asks first: confirm "أرشفة"). Expected: gone from the list; the archived filter shows it with "استعادة". Add a new `660 UC` (amount 660), then restore the archived one: refused, "يوجد عنصر آخر بهذا الاسم في المكان نفسه. اختر اسمًا آخر.". Archive the new one, restore the first: back in the list with amount 660.
2. "إدارة الفئات": archive "اختبار النظام". Expected: "أرشفة الفئة" with "ستختفي فئة «اختبار النظام» من المتجر. لا يمكن أرشفتها ما دامت فيها ألعاب غير مؤرشفة."; confirm: refused, "في هذه الفئة ألعاب غير مؤرشفة: لعبة اختبار 7، تطبيق اختبار 7. انقلها إلى فئة أخرى أو أرشفها أولًا." (the two names in either order).
3. B → "البيانات": category "ألعاب الموبايل", save. Expected: "نقل اللعبة إلى فئة أخرى يضعها في آخر ترتيبها."; in the catalog B is **last** in ألعاب الموبايل (22nd), "متوقفة"; the store unchanged (B is paused). Move it back to "اختبار النظام": after A.
4. In "اختبار النظام" move B up. Expected: B, A; move it down: A, B.
5. On B's page "أرشفة". Expected: "أرشفة اللعبة" with "ستختفي «تطبيق اختبار 7» وباقاتها من المتجر. قواعد تسعيرها تبقى وتعود عند الاستعادة."; after it, "هذه اللعبة مؤرشفة" with "لا تظهر في المتجر. استعدها لتعود كما كانت."; the catalog's archived filter (in "اختبار النظام") lists B. "استعادة": B back in "اختبار النظام", "متوقفة", with its code pack, region and instructions unchanged.

Result: ✅ (2026-10-17)

### 7.11 Only the admin changes the catalog

**What this checks:** the catalog changes only through the signed-in panel; anyone else reads only what the store shows.

1. In TC1's browser open `https://digital-admin.vertexmedia.pro/api/admin/catalog/games` and `https://digital-admin.vertexmedia.pro/api/admin/catalog/categories`. Expected: 401, no data.
2. Open `https://digital.vertexmedia.pro/api/admin/catalog/games`. Expected: 404.
3. In the private window (signed out) open `https://digital.vertexmedia.pro/api/catalog/storefront`. Expected: the six real categories with their active games only; no "اختبار النظام", no paused game, no supplier, cost or margin field.
4. Optional (developer tools, Network, in the panel): the answer of `/api/admin/catalog/games` carries `Cache-Control: no-store`.

Result: ✅ (2026-10-17)

### 7.12 The audit log has every catalog change

**What this checks:** every change to what the store sells can be traced to who made it and when, with what it was before.

Reorders are filed under their parent: games under the category, fields and packs under the game.

1. In "سجل التدقيق" filter the entity type "فئة". Expected, newest first: "ترتيب الألعاب" (twice, 7.10 step 4), "ترتيب الفئات" (twice, 7.4), "تعديل فئة" (twice) and "إضافة فئة" (اختبار النظام); actor you, channel admin. **Nothing** for the refused archive of 7.10 or the refusals of 7.4.
2. Entity type "لعبة". Expected: "إضافة لعبة" for A and B; "تعديل لعبة" for the image and accent saves, A's status changes of 7.8 and B's moves of 7.10; "أرشفة لعبة" and "استعادة لعبة" for B; "ترتيب حقول الإدخال" (twice, 7.7) and "ترتيب الباقات" (four times, 7.9). Open A's activation: `status` before "paused", after "active". Open the cover save: the file ids. **Nothing** for the refused activations, the refused accent or the image uploads by themselves.
3. Entity type "حقل إدخال". Expected: "إضافة حقل إدخال" (2), "تعديل حقل إدخال" (the label), "أرشفة حقل إدخال" and "استعادة حقل إدخال"; the key shown as `identifier`. Nothing for the refused archive of 7.8.
4. Entity type "باقة". Expected: the five creations of 7.7, 7.9 and 7.10; "تعديل باقة" with `status` before and after for the pause, resume and pause of 7.9; the archives and restores of 7.10 step 1. Before today's entries, the latest are those of 2026-10-15.

Result: ✅ (2026-10-17)

### 7.13 Screens quality on desktop and phone

**What this checks:** the admin can run the catalog from either device without guessing.

1. On the PC, the panel in the light and dark themes: `/catalog` with its tabs, cards and filters, the categories dialog, A's tabs (the data form with both images and the contrast readout, the fields with the select field, the packs with the archived filter), the field and pack dialogs of both kinds, B's archived notice. Expected: readable, RTL, Latin digits; slugs, keys, colors and ids left to right; every refusal under its field or at the top of its form, the typed values kept.
2. On the phone: `/catalog` (the tabs scroll, the cards in one column), A's tabs, the packs table scrolling within its frame, the move buttons reachable; no horizontal page scroll.
3. With the keyboard only (PC): reach "إضافة لعبة", a card's move buttons and the status switch, and use them.

Result: ✅ (2026-10-17)

### 7.14 Clean-up: the test records archived

**What this checks:** test items leave the store for good while their history stays.

1. Archive game A, then game B. Expected: "هذه اللعبة مؤرشفة" on each.
2. "إدارة الفئات": archive "اختبار النظام". Expected: accepted (no unarchived game left); its archived tab lists it; six categories left, in their order.
3. Open A again (from its audit entry or the browser's history). Expected: "هذه اللعبة مؤرشفة" with "فئتها مؤرشفة أيضًا: استعد الفئة أولًا."; "استعادة" is refused with "العنصر الأب مؤرشف. استعده أولًا.".
4. The store (reload). Expected: the six real categories as in 7.3; `/games/system-test-7` and `/games/system-test-7-app` the not-found page.
5. The panel: the counts of 7.1 (57 games, ببجي موبايل "الباقات: 29") and PUBG Mobile's packs as in 7.2: nothing real changed.

Result: ✅ (2026-10-17)

### Feature 7 sign-off

| Item | Value |
|---|---|
| Cases passed | 14 of 14 |
| Findings | F7-1 and F7-2 (found while writing the steps from the production records: catalog content) deferred to "After the last feature: the professional catalog" (owner, 2026-10-17); F7-3 (nginx's 413 read as an unexpected error in the panel) fixed with the results; F7-4 to F7-14 from an external audit by another model (GPT 6.1 sol, review only, 11 findings: five major, six minor, no blocker), each confirmed in the code (and, for A1, A2 and A3, with a test that fails without the fix) and fixed; F7-15 (a rare race noted by the reviewer) accepted |
| Checked by Claude (read-only, production, 2026-10-17, after 7.14) | Real catalog unchanged: 6 categories, 57 active games, 587 unarchived packs (172 active), 41 fields, PUBG Mobile 29 live and 18 archived packs, no real game or pack updated or audited that day; `system-test`, `system-test-7` and `system-test-7-app` archived. The day's catalog audit entries match 7.12 (category: 1 created, 2 updated, 2 reordered, 1 archived; game: 2 created, 6 updated, 3 archived, 1 restored; field: 2 created, 1 updated, 1 archived, 1 restored; pack: 5 created, 3 updated, 2 archived, 1 restored; 4 pack reorders), with one game reorder and two field reorders more than the steps name, from the keyboard check of 7.13 |
| Accepted by the owner on | 2026-10-17; the audit fixes accepted by Claude on 2026-10-17 (every check green, the reviewer's two findings closed) |
| PR | the steps (#125); the results and the F7-3 fix (#126); the external audit's fixes, F7-4 to F7-15 (this file's PR) |
