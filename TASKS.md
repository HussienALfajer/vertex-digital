# TASKS — Launch hardening · `fix/launch-hardening`

Four fixes found on 2026-10-14 while testing production, one branch and one PR.

## Fix 1 — the store serves /favicon.ico
- [x] `apps/store/src/app/favicon.ico` (16, 32, 48 px, rendered from `brand/logo/svg/favicon.svg`): the App Router's file convention answers `/favicon.ico` with 200
- [x] nginx: `location = /favicon.ico` proxied to the store with a day's browser cache, the store headers included again
- [x] Other referenced assets: the layout's SVG icon and apple-touch icon, the manifest's three icons and the service worker's icon and badge are hashed build files (no 404); the share pages' `og:image` is the API's
- [x] E2E (`pwa.spec.ts`): `/favicon.ico` is an icon with 200, every head icon and manifest icon answers 200
- [x] Docs: `brand/README.md` (the derived ICO), `apps/store/CLAUDE.md`

## Fix 2 — a failed submit takes the user to the first invalid field
- [x] `packages/ui/src/lib/focus-invalid.ts`: `focusFirstInvalid(root)` and `useFocusInvalid()`; `[data-slot=field]` scroll margin in `base.css`
- [x] Unit tests for the helper (happy-dom)
- [x] `InvalidAlert` next to the submit button (admin `common.invalidFields` in `components/form-alert.tsx`, store `forms.invalid` in `components/invalid-alert.tsx`, its own file so the game page stays in budget); skipped where the only field sits right above the button
- [x] Apply to every form (inventory below)
- [x] E2E admin (`e2e/forms.spec.ts`): deposit settings (empty Sham Cash name focused), the re-authentication dialog (empty, then a wrong code from the server), the tabbed page editor on a phone
- [x] E2E store: sign-up (`accounts.spec.ts`), the deposit amount refused before sending and by the server (`deposits.spec.ts`)
- [x] Screenshots where a screen changed (both themes): admin deposit settings refused, store sign-up refused (phone and desktop)
- [x] Docs: `packages/ui/CLAUDE.md`, `apps/admin/CLAUDE.md`, `apps/store/CLAUDE.md`

### Form inventory
Kinds: RHF = React Hook Form + `standardSchemaResolver`; own = own errors state; none = no field validation (search or filter forms, single buttons): nothing to focus.

Admin (`apps/admin/src/features/`):
- [x] `account/login-page.tsx` (RHF sign-in, backup code)
- [x] `account/change-password-form.tsx` (RHF, server error on the current password)
- [x] `account/reauthentication.tsx` (RHF in a dialog, server errors on password and code)
- [x] `account/totp-form.tsx` (one code field that submits itself; it already gives the focus back after a refusal)
- [x] `account/two-factor-setup-page.tsx`
- [x] `account/account-page.tsx` (backup codes)
- [x] `audit/audit-page.tsx` (filters: refused ids)
- [x] `catalog/catalog-page.tsx` (none: search)
- [x] `catalog/categories-dialog.tsx` (rename row, new category)
- [x] `catalog/field-dialog.tsx` (options fieldset marked)
- [x] `catalog/game-form.tsx` (+ `image-upload.tsx` marked)
- [x] `catalog/product-dialog.tsx`
- [x] `content/announcements-page.tsx`
- [x] `content/banner-dialog.tsx` (image fieldset marked)
- [x] `content/faq-dialogs.tsx`
- [x] `content/page-editor.tsx` (tabbed on phones: `reveal` switches to the form)
- [x] `customers/customer-dialogs.tsx`
- [x] `customers/customer-notes.tsx`
- [x] `customers/customers-page.tsx` (none: search)
- [x] `customers/test-customers-page.tsx` (RHF)
- [x] `deposits/approve-form.tsx` (unticked flags marked)
- [x] `deposits/decision-dialogs.tsx`
- [x] `deposits/deposit-settings-page.tsx` (the trigger; QR upload marked)
- [x] `deposits/deposits-page.tsx` (search too short)
- [x] `deposits/usdt-panels.tsx`
- [x] `orders/decision-dialogs.tsx`
- [x] `orders/fulfil-dialog.tsx` (proof fieldset marked)
- [x] `orders/new-order-page.tsx` (steps: customer, pack and account fields marked; server field refusals)
- [x] `orders/orders-page.tsx` (none: filters)
- [x] `orders/policy-page.tsx`
- [x] `orders/reroute-dialog.tsx` (routes fieldset marked)
- [x] `orders/share-links.tsx`
- [x] `pricing/rule-dialog.tsx`
- [x] `rates/rates-page.tsx`
- [x] `reconciliation/correction-dialog.tsx`
- [x] `reconciliation/count-dialog.tsx`
- [x] `reconciliation/explain-dialog.tsx`
- [x] `reconciliation/movement-dialog.tsx`
- [x] `reconciliation/reverse-movement-dialog.tsx`
- [x] `reconciliation/settings-sheet.tsx`
- [x] `reports/reports-page.tsx`
- [x] `suppliers/add-route-dialog.tsx` (no `<form>`: the dialog body; unmapped fields from the server)
- [x] `suppliers/catalog-tab.tsx` (none: search)
- [x] `suppliers/connection-tab.tsx` (three forms)
- [x] `suppliers/import-category-sheet.tsx`
- [x] `suppliers/import-dialog.tsx`
- [x] `suppliers/link-category-sheet.tsx`
- [x] `suppliers/offers-tab.tsx` (none: search)
- [x] `suppliers/policy-page.tsx`
- [x] `suppliers/routes-drawer.tsx` (field map, manual cost; `field-map-editor.tsx` and `option-map-editor.tsx` mark refused rows)
- [x] `support/new-ticket-page.tsx`
- [x] `support/support-page.tsx` (none: search)
- [x] `support/support-settings-page.tsx`
- [x] `support/ticket-page.tsx`
- [x] `wallet/adjust-dialog.tsx`
- [x] `wallet/reverse-dialog.tsx`
- [x] `wallet/wallets-page.tsx` (search too short)

Store (`apps/store/src/features/`):
- [x] `account/change-email-panel.tsx`
- [x] `account/password-card.tsx`
- [x] `account/profile-card.tsx`
- [x] `auth/forgot-password-panel.tsx`
- [x] `auth/sign-in-form.tsx`
- [x] `auth/sign-up-form.tsx` (the store's own `focusFirst` removed: one mechanism)
- [x] `auth/verify-email-panel.tsx`
- [x] `deposits/deposit-form.tsx`
- [x] `deposits/usdt-deposit.tsx` (TXID)
- [x] `deposits/usdt-form.tsx`
- [x] `players/players-page.tsx` (rename)
- [x] `support/new-ticket-page.tsx`
- [x] `support/ticket-page.tsx`
- [x] `purchase/buy-box.tsx` (no `<form>`: the details step; fields, gift, label, the player confirmation, server refusals)
- [x] `cart/cart-page.tsx` (none: no field to type; refusals are per line with the line's edit link)

## Fix 3 — `shared/.env` cannot be sourced by a shell
- [x] How api, worker and store load `.env`: Node's `process.loadEnvFile` (api, worker) and `util.parseEnv` (store), not dotenv; a single-quoted value parses to the same value in Node and bash (`$`, `#`, `;`, spaces literal)
- [x] `deploy/provision.sh` writes only hex, base64 and URLs (nothing to fix); `docs/deployment.md` now says hand-added values with shell characters go in single quotes
- [x] Server (read-only, asked for by the owner): `/root/SERVER.md` read; private temp copy (deleted): `bash -n` passes (valid syntax), Node scan: only line 30 `SMTP_PASSWORD` (a `;`, no space, no single quote)
- [x] Server, approved by the owner on 2026-10-15: backup (600), `SMTP_PASSWORD` quoted in single quotes, `bash -n` and a shell load without error, all 41 values' hashes identical (apps' parser and shell) before an atomic swap, `pm2 reload all --update-env` (three processes restarted, 0 unstable), health: API 200 with the database, store 200, a worker heartbeat after the restart, no new error-log line; the backup and `/root/vertexdigital-env.bak` (dated 2026-10-12) shredded, no copy left

## Fix 4 — pg "concurrent query on one client" deprecation in the worker
- [x] Reproduced with `node --trace-deprecation`; a debug preload named the queries: `supplierStates` and `productRoutingStates` (`packages/db/src/pricing/routing.ts`) in a transaction, and every `Promise.all` that may run on a transaction (packages/db, worker, api)
- [x] `readAll(db, reads)` (`packages/db/src/client.ts`): parallel through the pool, sequential in a transaction; applied to every such site (same queries, same transactions, one after another)
- [x] Guard: `no-concurrent-queries` setup files (db, api, worker) fail a test file on the warning; proven by putting the old `routing.ts` back (suppliers tests fail), `src/read-all.test.ts`; the worker starts without the warning

## Finish
- [x] Checks through the checker: lint, typecheck, test, build, e2e, drift (all pass; the first run caught a worker test's own `Promise.all` on a transaction and the banner dialog's alert after an upload refusal, both fixed)
- [x] Reviewer on the whole branch: no blocking issues
- [x] Docs made stale (folder CLAUDE.md files, `brand/README.md`, `docs/deployment.md`)
- [x] Commits, PR, auto-merge, report
