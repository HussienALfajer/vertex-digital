# 0036 — Merchant tools: volume levels, selling prices and order verification

Status: Accepted · Date: 2026-10-21 · Amends [0035](0035-price-lists-and-merchant-accounts.md) (the effective list gains the level), [0022](0022-order-fulfilment-timing-reviews-and-test-orders.md) (code releases for print and export), [0024](0024-cart-checkout-saved-ids-and-share-links.md) (50-line checkouts and saved IDs for merchants, branded receipts)

## Context
Phase M's merchant tools (F30–F39, S21) let shops sell at a counter, buy in bulk, print codes and receipts for their own customers, track their profit, and earn better prices with volume. The owner settled the rules in the S21 interview (2026-10-21). Three of them shape the system beyond one module: how a level changes what a merchant pays, how a shop's own prices relate to the ledger, and how anyone can verify a receipt without seeing personal data.

## Decision
- **Levels choose a list, below the admin's assignment.** The effective list is the list assigned to the account, else the list of the merchant's volume level, else the type default. A level is the highest whose monthly threshold (net wallet purchases in a Damascus calendar month) is reached by the previous or the current month: an upgrade is immediate, a downgrade happens on the 1st. Level lists are wholesale or custom lists, so S20's guards and the retail cap still hold. A level change that changes the list follows S20 AT3 (reservations cancelled). No level exists until the admin creates one.
- **Selling prices are the merchant's own bookkeeping.** A markup and per-product prices in USD or SYP (a SYP price stays fixed when the rate moves) produce a sale snapshot per merchant order, in its own table, never in the ledger and never changing the order. Profit is computed from it; a merchant's receipt shows the selling price and never the price paid.
- **Every order is verifiable.** Each order carries a 128-bit verification code; every receipt surface carries its QR, and a public page shows the order's facts (number, game, pack, quantities, state, delivery time, masked player ID) and never a price, a code or a person's data. A merchant's order shows the shop's name first, verified via VERTEX DIGITAL; the QR cannot be hidden.
- **Documents are rendered by the browser.** Print pages (thermal 58 and 80 mm, A4) give PDF through the print dialog; the api renders PNG with sharp and Pango and Excel with exceljs. No server-side PDF engine.

## Consequences
- What a merchant pays is still explained by one list and one price row (ADR 0035); the level only picks the list.
- Code releases for print, copy and export are logged per code like reveals, so every exposure of a code is traceable.
- Selling-price data can be wrong or missing without any effect on money or reports; the dashboard marks orders without one.
- A merchant's customers can learn that the order went through VERTEX DIGITAL; the owner accepted this for trust (decision 12 of S21).
