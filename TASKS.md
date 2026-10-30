# TASKS — S23 Merchant tiers, PR 2 "Identity and progress" (`docs/specs/S23-merchant-tiers.md`)

PR 1a (#230) and PR 1b (#231) are merged. Spec PR 2 (decisions 6–8: ID1–ID9, PG1–PG7, RC1–RC2, the welcome line's admin removal of AD5) ships as one PR (owner, 2026-10-30), server and store together, on `feat/s23-identity`. PR 3 (operations and reports) follows in its own session.

## PR 2 — identity and progress

### Server (contracts, db, api, worker)

- [x] contracts: `tierProgress`, `tierKeptUntil`, `tierForecast`, `tierReminder`, `welcomeTextSchema` (RC1) with unit tests at 100%; merchant tier summary, table, history, certificate and public certificate schemas (`.meta({ id })`); `CERTIFICATE_REISSUE_LIMIT` with its Arabic text; audit action `merchant.certificate_reissued`; notification event `merchant_tier_reminder` (center, email, push) and its preference; job `merchants.tier-reminders` (the 25th 10:00 Damascus); `merchant_level_changed` payload with what the tier grants
- [x] db (`/db-migration`): `merchant_profiles.celebrate_pending`, `certificate_code` (22 base64url chars, unique, backfilled), `certificate_reissued_at`; `merchant_receipt_settings.welcome_text`; TR6 sets `celebrate_pending` on a rise and the grant writes the certificate code; tests
- [x] api merchant routes: `GET /api/merchant/tier` (since, kept-until, progress, forecast, savings PG6, privileges incl. `orderUnitsMax` and `bulkLinesMax`; never the source), `GET /api/merchant/tier/table` (three packs' prices per tier, PG2), `GET /api/merchant/tier/history`, `POST /api/merchant/tier/celebrated`, `GET /api/merchant/certificate`, `POST /api/merchant/certificate/reissue` (3 a day, audited); `PUT /api/merchant/receipt-settings` with `welcomeText` (kept, printed only with `receipt_welcome`)
- [x] api public: `GET /api/certificates/:code` (60/min per IP, cached 30 s, revoked, unknown → `NOT_FOUND`, no personal data) and its nginx zone `vdcertificate` in `deploy/` (`/api/certificates/` and `/m/`, codes masked in the access log)
- [x] api identity data: the tier line on the receipt and branded receipt link and the verification page (ID5, current tier, none when revoked), the welcome line and large-logo flag on receipt data (RC1, RC2); the price list header and the PNG badge with the tier colour (ID6, RC2); the statement's "فئتك هذا الشهر" block and the Excel "الملخص" sheet (ID9)
- [x] worker: `merchants.tier-reminders` (push without the amount, PT2) (PG3, dedupe `tier-reminder:<customer>:<month>`, preference, frozen skipped), email and push texts for `merchant_tier_reminder`; `merchant_level_changed` texts name what the tier grants; tests run twice
- [x] tests per endpoint (success, 401, `NOT_MERCHANT`, other merchants, frozen on writes), reissue limit, certificate page cases, savings and progress cases
- [x] bridge: `pnpm build`, OpenAPI export, admin client regenerated

### Store

- [x] tier colour tokens in `brand/identity.md` and the UI tokens, measured for contrast (ID1); `TierBadge` in `packages/ui`
- [x] header and account menu badge (ID2); dashboard tier card replacing the level card (ID3) with progress bar (PG1), keep line, savings
- [x] celebration sheet (ID4, reduced motion)
- [x] tier page `/merchant/tier` (PG2 table, forecast PG4, history PG5; the Diamond contact comes in PR 3)
- [x] certificate print `/merchant/certificate/print` and public page `/m/[code]` (ID7, `noindex`), reissue action; sticker canvas PNG square and story with QR and Web Share (ID8)
- [x] receipts and verification badge line (ID5), welcome line and larger logo (RC1, RC2); receipt settings welcome field with counter and preview, disabled below Silver; statement tier block (ID9)
- [x] code-quantity input and bulk lines read `orderUnitsMax` and `bulkLinesMax` from `GET /api/merchant/tier` (moved from PR 1b)
- [x] i18n keys, loading, empty and error states
- [x] e2e: tier flow spec with mocks; RTL screenshots phone width dark and light (header badge per tier, tier card, celebration, tier page, receipt and verification, certificate print and page, receipt settings)
- [x] browser check on the local stack (acceptance 2–4): a seeded customer made a Gold merchant in the dev database (the seed creates no merchant), the celebration once, the tier page (card, forecast, table, history), the certificate print and its public page at phone width, the square and story stickers drawn (download stubbed), the welcome line saved and in the preview; fixed there: the forecast in whole cents, the certificate's icon black on paper
- [x] reviewer fixes: the admin removes a welcome line (`DELETE /api/admin/customers/:id/merchant/welcome-text`, re-authenticated, audited `merchant.welcome_text_removed`, the profile's row and dialog); the welcome filter on the NFKC form (any domain shape, `@handle`, 7+ digits of any script with any separator); a closed account's certificate shows as no longer approved; a re-grant writes a new certificate code
- [ ] checks once more, PR and merge

## Moved to later PRs (spec delivery plan)

- PR 3: deposit and ticket queue priority, reply promise and overdue job, the Diamond contact columns of `merchant_settings` (decision 12) and their panel fields, early access with its end job and notification, faster alerts, best-sellers helper, the report by tier.
