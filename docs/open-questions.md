# Open questions

Decisions that belong to the owner. Agents must not guess answers to these. When one is resolved, record the answer (and an ADR if it shapes the system) and move it to the resolved list.

| ID | Question | Needed before | Recommendation |
|---|---|---|---|
| Q1 | Off-server backup destination (shared need with Vertex Hub) | Launch | Required: the system holds customer money |
| Q2 | Madani Arabic: does the license cover web embedding on a public store (traffic, domains)? Provide the WOFF2 files (400, 500, 700) privately | Design system (fallback works until then); required before launch | Confirm or extend the license before launch |
| Q3 | License for the public repository (none means all rights reserved) | Anytime | — |
| Q4 | Sham Cash receiving account: personal or business, which currencies it accepts (SYP, USD), account number and QR | F05 | A dedicated business account used only by the store |
| Q5 | Deposit and purchase limits: minimum and maximum per deposit, daily limits, limits for new accounts; any deposit fee per method | F05, F06 | Low limits for new accounts, raised after the first successful orders; no fees at launch |
| Q6 | Exchange rate policy: one rate for display and deposits, or separate rates; the SYP rounding step; who may change the rate | F04 | One rate in V1; the admin changes it; step chosen with the owner |
| Q7 | Pricing policy: default margin (percent and minimum fixed) per category; USD price endings | F10 | Spec interview |
| Q8 | USDT: receiving addresses per network (owner-controlled wallets), required confirmations, minimum deposit, intent validity | F06 | Owner-held wallets; confirmations per network set in the spec |
| Q9 | Working hours for deposit review and manual fulfilment; target review time | F05, F17 | Shown to customers as the review ETA outside hours |
| Q10 | Terms of service, privacy and refund policies; business identity shown on the store | Launch (F21) | Drafted with the owner before the pilot |
| Q11 | Telegram: who creates the bot (BotFather) and which chat receives the alerts and deposit cards | F07 | The admin's personal chat for everything (ADR 0016) |
| Q12 | Supplier accounts: are SHOP2TOPUP and WDGZone accounts and API documentation ready? Which games and packs launch first? | F09 | Start with PUBG Mobile UC and Free Fire diamonds on both suppliers |
| Q13 | Source of the "official price" used for savings (entered by the admin per pack, or not shown when unknown) | F08 | Entered by the admin; hidden when unknown |
| Q14 | Support channels besides tickets (WhatsApp or Telegram links on the store) | F23 | Tickets plus one Telegram support link |
| Q15 | Sentry: account owner and organization for the three apps | Phase 0 deploy skeleton | Free plan under the owner's email |
| Q16 | Who draws the final VERTEX DIGITAL wordmark (agent in Phase 0 from the Vertex Media style, or a designer) | Phase 0 design system | Agent draft in Phase 0 (done: `brand/logo/svg/vertex-logo.svg`, the DIGITAL mark over the Vertex Media VERTEX wordmark), designer files later replace it |

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
