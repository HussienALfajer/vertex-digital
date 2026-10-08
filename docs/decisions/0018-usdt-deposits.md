# 0018 — USDT deposits in V1

Status: Accepted · Date: 2026-10-08 · Amends [0006](0006-payments-and-deposits.md), [0017](0017-sham-cash-deposits-and-exchange-rate.md)

## Context
The S04 spec (F06) settled the open questions on USDT limits (Q5, USDT part) and on addresses, minimum and intent validity (Q8) with the owner. Some answers change what ADR 0006 and the V1 scope said:
- how a transfer reaches a deposit (the scope said by TXID only);
- where the receiving addresses live;
- what happens to transfers of the wrong token;
- whether a deposit can be decided without the admin.

## Decision
- **Automatic detection** (owner, 2026-10-08). The worker watches each store address for final official-USDT transfers and credits an exact match without a TXID. Pasting the TXID or an explorer link stays available, to start verification at once. This amends F06 and A01 in the scope.
- **Exact amount with a sub-cent tail.** The amount to pay is the declared whole-cent amount plus a random tail of 0.0001–0.0099 USDT. The tail is unique among the network's reserved deposits. An exact match credits exactly the declared amount. The tail goes to a `deposit_rounding` ledger account, so the books equal what arrived on chain.
- **Addresses in the server environment** (owner, 2026-10-08), never editable in the panel. A stolen admin session cannot redirect deposits. The boot refuses an address that fails its checksum. The server holds no private key (ADR 0006).
- **Validity 24 hours** (owner, 2026-10-08), as Sham Cash. The amount stays reserved 7 more days after expiry or cancellation, so a late transfer is listed with its candidate deposit, never credited to someone else.
- **Limits** (owner, 2026-10-08): the Sham Cash tiers and one 24-hour window shared across all methods (new account $50 per deposit and $100 per 24 hours; established $300 and $1,000), with a USDT minimum of **$5**. All are panel settings.
- **Finality before credit**: a TRON transaction in a solidified block; a BSC transaction at or below the `finalized` block with at least 15 confirmations. A reader error never counts as "not found".
- **Mismatches** (amends ADR 0006):
  - A different amount, the other network, or a transfer sent before the deposit go to the admin's review. The credit is the received amount floored to whole cents, never a typed amount, and always needs re-authentication.
  - A failed transaction, one that pays the store nothing, or one that moves only a non-official token **bounces** the deposit back to `pending` with the reason, instead of going to review. Fake "USDT" tokens would otherwise fill the queue with deposits the admin can only reject.
- **System decisions**: a deposit can be credited by the system (`decided_by = 'system'`), with no admin id or decision key. Admin decisions keep the ADR 0017 rules.
- **Every official-USDT transfer to a store address of at least $1** is recorded, append-only, for review, for the list of unmatched transfers, and for the reconciliation (F20). An unmatched transfer is credited only through an S02 `manual_deposit`, which claims the same normalized TXID in `payment_references`.
- **One reader per network** (TronGrid; a BSC JSON-RPC provider), with a fake reader for development and tests. A second, cross-checking reader is not in V1. The nightly reconciliation covers a lying reader.

## Consequences
- Most USDT deposits credit within about a minute of the transfer, with no admin and no TXID.
- Customers whose exchange deducts its fee from the amount land in review. The wizard warns them. Whether major exchanges can send 4 decimals is checked in the owner's live check before the pilot. If they cannot, this ADR is revisited.
- 99 tails per amount and network bound the number of reserved deposits of one amount. That is enough at V1 volumes; past that, the store suggests a cent more or less.
- Changing an address needs server access and a quiet moment with no open USDT deposits.
