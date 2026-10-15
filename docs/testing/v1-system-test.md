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

## Feature order

Ordered by dependency: access and its audit trail first, then money in, then what money buys, then operations on top, and the money check last so it covers everything the test did.

| # | Feature | Scope IDs | Why here | Status |
|---|---|---|---|---|
| 1 | Admin access, 2FA and audit log | F02 | Every later step is an admin action that must be authenticated, re-authenticated and audited; the audit log is the tool used to verify the rest | Accepted 2026-10-15 |
| 2 | Customer accounts | F01 | Every customer case needs sign-in, sessions and account emails working | — |
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
| F1-1 | 1 | Code audit | Admin API answers (audit log, sessions) carried no `Cache-Control`: a shared computer's browser could keep private data in its cache | minor | Every `/api/admin/*` answer defaults to `no-store` (`core/http/admin-no-store.ts`), with this file's PR | Fixed |
| F1-2 | 1 | Code audit (1.8) | The own-sessions list kept sessions past their 12 hours or idle for 30 minutes, which sign nobody in | minor | Only live sessions are listed (`AdminAccountService.sessions`), with this file's PR | Fixed |
| F1-3 | 1 | Code audit (1.10) | The backup-codes download released its file at the moment of the click, which can cancel the download in some browsers | minor | Released a second later, with this file's PR | Fixed |
| F1-4 | 1 | Code audit | The re-authentication password and the current password of a password change had no length limit | minor | Bounded at 128 like every password, with this file's PR | Fixed |

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
| Findings | F1-1 to F1-4 (code audit, all minor, fixed) |
| Accepted by the owner on | 2026-10-15 |
| PR | — |
