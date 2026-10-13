# Store page texts (Q10)

Drafts of the four S14 pages, written from the project's rules for the owner to review, complete and publish in the admin panel (Panel → المحتوى → الصفحات). Each file is the page **body** only, in the S14 limited Markdown (MD1–MD4: `##`/`###` headings, bold, lists, internal links only); all four pass `richTextProblems` with no problem. The titles are the seeded draft titles.

| Page | Title | Store route | File |
|---|---|---|---|
| `terms` | الشروط والأحكام | `/terms` | [terms.md](terms.md) |
| `privacy` | سياسة الخصوصية | `/privacy` | [privacy.md](privacy.md) |
| `refund` | سياسة الاسترداد | `/refund` | [refund.md](refund.md) |
| `about` | من نحن | `/about` | [about.md](about.md) |

## Publishing

The texts are complete: paste each body into its page's editor, preview and publish. Publish `terms` and `privacy` together: the sign-up sentence (S14 TA1) and the accepted versions (TA2) start with the first publication. These files are the reviewed draft; the panel's version history is the record of what was published, and later edits are made there.

## Sources

| Rule in the texts | Source |
|---|---|
| USD wallet, SYP shown at the store rate, no withdrawals, refunds to the wallet, exceptional cash refunds outside the system | ADR 0003, scope §6 |
| Sham Cash in SYP or USD, 15-minute rate lock, 24-hour validity, review hours, limits per tier, no store fees | ADR 0017, S03 |
| USDT TRC20/BEP20, exact amount with a tail, mismatches to review and credited as received, non-official tokens not credited, 24-hour validity | ADR 0018, S04 |
| Price checked at pay, delivery automatic, measured delivery times, live order page | S08, S09 |
| Automatic refunds: no route, routes exhausted, input rejected, undelivered units of a partial delivery; delivered orders final; no customer cancellation; unknown outcomes never sent elsewhere until resolved | ADR 0004, 0013, S08 R5, F1, D5, D6; S16 RS1 |
| Make-good for a delivered order is a wallet compensation | S08 D6, S02 |
| Player validation warning and "I am sure" confirmation | S09 PV7, PV8 |
| Reservations: 24 hours, at most 3, paid at the lower price, cancellable, expiry takes nothing | S09, ADR 0023 |
| Gifts and share links: public, no codes, revocable | S10 |
| Codes encrypted, shown only to the buyer, reveals logged | S08 C1–C3 |
| Freeze keeps the balance, sign-in, codes and tickets | ADR 0026 |
| Emergency stop, margin guard (never below cost) | S05, ADR 0020 |
| Personal data collected and shared, sign-in log 90 days, OTP purge, records never deleted, archive with zero balance and the email reserved | S01, S03, S05 TC2, S08, S09, S10, S12, S15 |
| No analytics or third-party trackers; session cookie and local storage keys (cart, theme, dismissed announcement, install and push cards) | `apps/store/src` (checked 2026-10-13) |
| Game account passwords never asked | Q20 (not sold in V1) |

## Owner answers (2026-10-13)

1. **Operator:** Vertex Media.
2. **Address** (shown on "من نحن"): Syria, Aleppo, Azaz, the Black Mall (المول الأسود), fourth floor, office 409.
3. **Relation to Vertex Media:** nothing beyond naming it as the operator.
4. **Contact:** tickets and the panel's Telegram link only, for now.
5. **Governing law and disputes:** none stated, for now; the terms have no such section.
6. **Minimum age:** none.
7. **Faulty delivered order:** reported by a ticket within 7 days of delivery; when the supplier confirms the fault is not the customer's, the full price of the affected units is credited to the wallet as a compensation (S02, S08 D6).
8. **Rejected deposit whose money arrived:** the customer opens a ticket with proof; once the money is confirmed, it is credited to the wallet (an S02 `manual_deposit` claiming the same reference), never returned in cash.
9. **Exceptional cash refunds:** mentioned, as the management's discretion, recorded in the wallet history, never a right (ADR 0003).
10. **Wallet balance:** never expires.
11. **Third parties:** generic descriptions, no provider names or hosting country.
12. **About page:** a professional story, with no founding year or figures.
