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
| 3 | Exchange rate and SYP display | F04 | SYP deposits and every SYP price depend on it | — |
| 4 | Sham Cash deposits | F05 (+ F07, F27 deposit parts) | First money in; the manual review path with its Telegram card and emails | — |
| 5 | USDT deposits | F06 | The automatic money-in path | — |
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

Result: ✅ 2026-10-15, re-run after the deploy of aba5ee3 with a new address (SU3): `qwerty123` refused, a second sign-up with the same address sent the attempt notice and no new code (F2-3). First run ❌: `password123` accepted (F2-2, accepted) and the code voided by a second sign-up (F2-3).

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

Result: ✅ 2026-10-15, re-run after the deploy of aba5ee3: the six-slot field filled from one paste (F2-4); after a reload the page asked for the password and the code with it signed in (F2-7).

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

Result: ✅ 2026-10-15

### 2.11 Sessions list and signing out

**What this checks:** the customer sees every signed-in device and can end one or all of them, for example after losing a phone.

1. Sign TC1 in on the phone again, so TC1 has the PC and the phone.
2. On the PC, "حسابي" → "الأجهزة المسجّل دخولها". Expected: two rows with browser and system, IP and last activity; the PC row has "هذا الجهاز".
3. Press "تسجيل الخروج" on the phone's row. Expected: the row goes; on the phone the next tap signs out.
4. Sign in on the phone once more. On the PC press "تسجيل الخروج من كل الأجهزة" → confirm.
5. Expected: the PC goes to the sign-in page with "سُجّل خروجك من كل الأجهزة"; the phone is signed out at its next tap.

Result: ✅ 2026-10-15

### 2.12 Change email

**What this checks:** an account cannot be stolen by changing its email: it needs the password and a code sent to the new address, the old address is told, and other devices are signed out.

1. Sign SU in on the PC and the phone.
2. On the PC, "حسابي" → email "تغيير". Enter TC3's address (`+tc3`) and SU's password. Expected: the same "code sent" step as for a free address, no code arrives at `+tc3`, and `+tc3` gets "someone tried to sign up with your email" (TC3, not TC2: that notice goes to one address at most once an hour). Go back.
3. Enter the new address `+su2` with a **wrong** password, once. Expected: refused.
4. Enter `+su2` with the right password. Expected: a code arrives at `+su2` (not at `+su`).
5. Enter the code. Expected: "تغيّر بريدك الإلكتروني، وأرسلنا إشعارًا إلى بريدك السابق."; the profile shows `+su2`.
6. Expected: `+su` (the old address) gets "your email was changed"; the phone is signed out at its next tap.
7. Sign out, then sign in with `+su2`. Expected: works; `+su` no longer signs in.

Result: ✅ 2026-10-15

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
| Cases passed | 15 of 15 (2.3, 2.5 and 2.14 after the fixes, deployed as aba5ee3) |
| Findings | F2-1 (not a bug), F2-2 (accepted: the owner keeps the common-password list), F2-3 to F2-7 (fixed) |
| Accepted by the owner on | 2026-10-15 |
| PR | —
