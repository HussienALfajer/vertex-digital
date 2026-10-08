# 0006 — Payments and deposits

Status: Accepted · Date: 2026-10-06 · Amended by [0016](0016-single-admin-account.md) (one admin account, no staff or roles), [0017](0017-sham-cash-deposits-and-exchange-rate.md) (Sham Cash deposits and the exchange rate)

## Context
Customers fund their wallet before buying. At launch two methods exist: Sham Cash (a Syrian e-wallet with no merchant API, so transfers are checked by a person) and USDT (a public blockchain, so transfers can be checked by machine). Manual deposits attract edited screenshots and reused receipts.

## Decision

### Common rules
- A deposit is a record with a state machine: `pending` → `submitted` → `credited` | `rejected` | `expired`, each change with an audit entry. A credited deposit posts one journal (ADR 0003) with the deposit id as idempotency key, then triggers A02 (pay waiting orders).
- Deposit creation requires an `Idempotency-Key`. Limits per deposit, per day and for new accounts come from settings and per-customer overrides (F19); values are an open question for the owner.
- Frozen customers cannot create deposits.

### Sham Cash (manual review)
- The wizard creates a deposit with a **unique reference code** (short, unambiguous characters, e.g. `VD-7K3Q9`) that the customer writes in the transfer note, shows the store's Sham Cash account as a QR code and copy buttons, the amount (with the 15-minute SYP rate lock when in SYP, ADR 0003), and takes the receipt by paste or upload.
- Receipts: images only, size-limited, re-encoded server-side (EXIF stripped), stored outside the web root, served only to staff through the API (nginx internal location). An exact hash and a perceptual hash are stored for duplicate detection.
- The reviewer approves with the Sham Cash **transaction number** (unique across all deposits, enforced by the database) and the amount actually received; the credited amount follows what was received, converted at the locked rate when valid. Rejection needs a reason the customer sees.
- Fraud signals (A10): transaction number or receipt hash seen before, reference missing or belongs to someone else, amount mismatch, new account with a large amount, deposit velocity. A flagged deposit cannot be approved from Telegram.
- The customer sees a **real review ETA**: the median review time of recent deposits, and working hours when outside them.
- Telegram (F07): reviewers get a card with the receipt and Approve / Reject buttons; approving there is allowed only up to a configured amount and only for unflagged deposits; it runs the same service path and audit as the panel, with the channel recorded.

### USDT (automatic verification)
- Networks: **TRC20** (TRON, official USDT contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) and **BEP20** (BNB Smart Chain, official USDT contract `0x55d398326f99059fF775485246999027B3197955`). The contract addresses are constants in `packages/contracts`, checked against the official sources in the F06 spec.
- The customer creates a deposit intent; the intent gets an **exact amount with a unique fractional tail** (e.g. 25.0137 USDT) valid for a limited time, and the store's receiving address for the chosen network. The tail binds an on-chain transfer to one intent, so a TXID seen on chain cannot be claimed by another customer.
- The customer submits the TXID (or an explorer link). The worker verifies through a chain-reader interface (TronGrid for TRON, a BSC JSON-RPC endpoint for BEP20; API keys in the environment): the transfer is to our address, of the official contract, for the exact intent amount, with the required confirmations, and the TXID is unused (unique per network in the database). Then it credits the wallet with the received amount, 1 USDT = 1 USD, in whole cents.
- Under- or over-payments, wrong network or wrong token are not credited automatically: the deposit goes to staff review with the reason.
- The server holds **receiving addresses only, never private keys**. Wallets are controlled by the owner outside the server.

## Consequences
- USDT deposits credit in minutes without staff; Sham Cash deposits depend on reviewer availability, shown honestly to the customer.
- The fractional-tail amount is slightly unusual for customers; the wizard explains it and copy buttons make it easy.
- Sham Cash automation (Phase 4) can replace the reviewer's step without changing the deposit model.
