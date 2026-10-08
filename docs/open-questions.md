# Open questions

Decisions that belong to the owner. Agents must not guess answers to these. When one is resolved, record the answer (and an ADR if it shapes the system) and move it to the resolved list.

| ID | Question | Needed before | Recommendation |
|---|---|---|---|
| Q1 | Off-server backup destination (shared need with Vertex Hub) | Launch | Required: the system holds customer money |
| Q2 | Madani Arabic: does the license cover web embedding on a public store (traffic, domains)? Provide the WOFF2 files (400, 500, 700) privately | Design system (fallback works until then); required before launch | Confirm or extend the license before launch |
| Q3 | License for the public repository (none means all rights reserved) | Anytime | — |
| Q10 | Terms of service, privacy and refund policies; business identity shown on the store | Launch (F21) | Drafted with the owner before the pilot |
| Q12 | Supplier accounts and API documentation for SHOP2TOPUP and WDGZone (the launch catalog part was answered on 2026-10-08) | The `shop2topup` and `wdgzone` adapter PRs (S07 is built and accepted with the fake and manual suppliers) | Share each supplier's documentation (files or links) when the account is ready; keys are entered in the panel only |
| Q14 | Support channels besides tickets (WhatsApp or Telegram links on the store) | F23 | Tickets plus one Telegram support link |
| Q15 | Sentry: account owner and organization for the three apps | Phase 0 deploy skeleton | Free plan under the owner's email |
| Q16 | Who draws the final VERTEX DIGITAL wordmark (agent in Phase 0 from the Vertex Media style, or a designer) | Phase 0 design system | Agent draft in Phase 0 (done: `brand/logo/svg/vertex-logo.svg`, the DIGITAL mark over the Vertex Media VERTEX wordmark), designer files later replace it |
| Q17 | S07 rule P3: a large cost change seen through another basis route (a non-basis supplier drops its cost to near zero, so its route becomes the basis) reprices at once without review. Should such a basis switch also go to review when the price moves more than the threshold? | The second real adapter (`shop2topup` or `wdgzone`); it cannot happen with only `fake` and `manual` | Review it too: the spec's abuse row says a cost dropped near zero is held for review |

## Resolved

| Question | Answer | Date |
|---|---|---|
| Name, folder and package scope | VERTEX DIGITAL, `D:\vertex-digital`, `@vertex-digital/*` | 2026-10-06 |
| Domains | Store and API `digital.vertexmedia.pro` (API under `/api`); admin `digital-admin.vertexmedia.pro` (ADR 0009) | 2026-10-06 |
| Hosting | The existing VPS shared with Vertex Hub, PM2 + nginx (ADR 0009) | 2026-10-06 |
| Repository visibility | Public on GitHub for now; may become private later | 2026-10-06 |
| CDN | No Cloudflare (blocked in Syria); ALTCHA, nginx limits, fail2ban (ADR 0008) | 2026-10-06 |
| Stack | ADR 0002 | 2026-10-06 |
| Base currency and SYP | USD base; SYP shown everywhere and accepted for deposits with stored rates; 15-minute rate lock (ADR 0003) | 2026-10-06 |
| Payment methods at launch | Sham Cash (manual review) and USDT TRC20/BEP20 (automatic) (ADR 0006) | 2026-10-06 |
| Suppliers | SHOP2TOPUP primary, WDGZone backup, manual and fake (ADR 0005) | 2026-10-06 |
| Customer verification | Email OTP only; phone required and format-validated, not verified (ADR 0007) | 2026-10-06 |
| UI languages | Arabic only in V1, i18n ready; English in Phase 4 (ADR 0012) | 2026-10-06 |
| Wallet withdrawals | None in V1; refunds to the wallet; exceptional owner cash refunds recorded as adjustments (ADR 0003) | 2026-10-06 |
| Arabic font | Madani Arabic, files private, Noto Kufi Arabic fallback (ADR 0012) | 2026-10-06 |
| Logo | The Vertex mark with a VERTEX DIGITAL wordmark (ADR 0012) | 2026-10-06 |
| Phone numbers | Syrian by default, international allowed, stored in E.164 (ADR 0007) | 2026-10-06 |
| Sending mailbox | `info@vertexmedia.pro` initially, configurable by `EMAIL_FROM` (ADR 0007) | 2026-10-06 |
| Pilot shape | Open quiet launch with low limits, no invite codes (`docs/ROADMAP.md`) | 2026-10-06 |
| Digits in the UI | Latin digits, `ar-u-nu-latn` (as in Vertex Hub) | 2026-10-06 |
| Sham Cash account (Q4) | The customer chooses SYP or USD; the admin uploads one QR image per currency from the Sham Cash app; account name, number and QR are panel settings (S03, ADR 0017) | 2026-10-08 |
| Sham Cash limits (Q5, Sham Cash part) | Minimum $2; new account $50 per deposit and $100 per 24 hours; established $300 and $1,000; no fees; one deposit awaiting a receipt and three under review per customer; editable in the panel (S03, ADR 0017) | 2026-10-08 |
| Exchange rate policy (Q6) | One rate for display and deposits, set by the admin with re-authentication and a typed confirmation above a 5% change; display step 5 SYP; stale warning after 48 hours (S03, ADR 0017) | 2026-10-08 |
| Deposit review hours (Q9) | Daily 10:00–22:00 `Asia/Damascus`, target 15 minutes; the customer sees the real median ETA or the next opening (S03) | 2026-10-08 |
| USDT limits (Q5, USDT part) | The Sham Cash tiers and one 24-hour window shared across all methods; USDT minimum $5; editable in the panel (S04, ADR 0018) | 2026-10-08 |
| USDT addresses, confirmations, minimum and validity (Q8) | Owner-held wallets, addresses in the server environment only (not editable in the panel); TRON solidified (19 blocks), BSC finalized with 15 confirmations; minimum $5; deposits valid 24 hours, amount reserved 7 more days; automatic detection of exact-amount transfers besides the TXID (S04, ADR 0018) | 2026-10-08 |
| Telegram bot and chat (Q11) | The owner creates the bot with BotFather; its token stays in the server environment; cards, alerts, reminders and the daily summary (22:30 `Asia/Damascus`) all go to the admin's private chat, linked from the panel (S05, ADR 0019) | 2026-10-08 |
| Pricing policy (Q7) | Global margin 10% with a $0.10 minimum, editable per category, game and product; USD prices rounded up to whole cents; prices follow the cheapest healthy route (S06, ADR 0020) | 2026-10-08 |
| Official price for savings (Q13) | Entered by the admin per product; savings hidden when unknown or not lower (S06, ADR 0020) | 2026-10-08 |
| Launch catalog (Q12, catalog part) | Everything the suppliers offer, imported progressively as paused products the admin activates; the adapters wait for the documentation (S07, ADR 0021) | 2026-10-08 |
| Supplier sync and price review (S07) | Sync every 15 minutes, costs stale after 2 hours; a supplier cost change above 10% either way waits for review; route changes reprice at once; manual supplier as last resort; health and $50 balance alerts; a Telegram summary only when something needs the admin; supplier funding recorded with reconciliation (S13) (ADR 0021) | 2026-10-08 |
