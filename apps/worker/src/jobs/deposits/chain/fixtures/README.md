# Chain reader fixtures

Replies of TronGrid and a BSC JSON-RPC provider, used by `apps/worker/test/chain-readers.test.ts`.

These were **not recorded live**: the build environment could not reach the providers (2026-10-08).
They are synthetic, shaped after the documented replies (`/walletsolidity/gettransactioninfobyid`,
`/wallet/getnowblock`, `/v1/accounts/<address>/transactions/trc20`, `/v1/accounts/<address>` (S13: `tron-account.json`, the TRC-20 balances), `eth_getTransactionReceipt`,
`eth_getBlockByNumber`, `eth_getLogs`; the BSC `eth_call` balance is scripted in the test). Every TXID, account and sender is made up; no customer data.
Replace them with sanitized recordings of public transactions before the owner's live check.
