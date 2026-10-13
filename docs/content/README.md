# Store page texts (Q10)

Drafts of the four S14 pages, written from the project's rules for the owner to review, complete and publish in the admin panel (Panel → المحتوى → الصفحات). Each file is the page **body** only, in the S14 limited Markdown (MD1–MD4: `##`/`###` headings, bold, lists, internal links only); all four pass `richTextProblems` with no problem. The titles are the seeded draft titles.

| Page | Title | Store route | File |
|---|---|---|---|
| `terms` | الشروط والأحكام | `/terms` | [terms.md](terms.md) |
| `privacy` | سياسة الخصوصية | `/privacy` | [privacy.md](privacy.md) |
| `refund` | سياسة الاسترداد | `/refund` | [refund.md](refund.md) |
| `about` | من نحن | `/about` | [about.md](about.md) |

## Before publishing

Every `«…»` is a fact only the owner can give (questions below). Replace each one, then paste the body into the page's editor, preview and publish. Publish `terms` and `privacy` together: the sign-up sentence (S14 TA1) and the accepted versions (TA2) start with the first publication. These files are the reviewed draft; the panel's version history is the record of what was published, and later edits are made there.

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

## Questions for the owner

1. **Operator:** the legal or trade name shown as the operator, and whether it is a registered business (with a registration number to show) or a person.
2. **Location:** the city (and address, if any) to show on "من نحن".
3. **Vertex Media:** how VERTEX DIGITAL relates to Vertex Media, if the page should say so.
4. **Contact:** besides tickets and the Telegram link, a support email, phone or WhatsApp to list?
5. **Governing law and disputes:** which law applies (Syrian law?) and which courts or body settle disputes.
6. **Minimum age** for an account (18, or younger with a guardian's consent).
7. **Faulty delivered order:** how long after delivery a customer may report "delivered but not received" or a code that does not work, and the remedy when the supplier confirms it (wallet compensation, a replacement code, or either).
8. **Rejected deposit whose money did arrive** (for example, a receipt rejected as unclear after the request for a clearer one): is the amount credited later after a ticket, or returned through Sham Cash?
9. **Exceptional cash refunds** (ADR 0003): mention them on the refund page (and when they apply), or say nothing?
10. **Dormant balance:** confirm that a wallet balance never expires (the texts do not mention expiry).
11. **Third parties:** name the email provider, the error-monitoring service (Sentry) and the hosting country in the privacy policy, or keep the generic descriptions?
12. **About page story:** a founding year or a short story to add, if any.
