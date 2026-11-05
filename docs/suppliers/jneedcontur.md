# jneedcontur (`jneedcontur`)

A store on the zddk platform (Technorex's white-label store SaaS) that resells TweetPin's Syrian credit, bills and cash, Jawaker, about 170 chat apps and the games WDGZone sells. **Status: the third automatic supplier (S25, ADR 0039), through the generic `zddk` adapter** (`packages/suppliers/src/zddk/`, S25 PR 2). Its value is the "الرصيد والفواتير" section (F44); its game prices are 2–13% above WDGZone, so its game routes are a fallback that competes on cost (S25 D11).

Sources: the store's public API documentation `https://api.jneedcontur.net/api-docs` (read 2026-11-04 and 2026-11-05), the `api_docs` page and the product data of the owner's account (read only on 2026-11-04; nothing bought), and the analysis `reports/تحليل واجهة jneedcontur كمورد 2026-11-04.md` (local, git-ignored). **No live reply has been recorded**: agents never call the live API, and the documentation gives success examples only. Everything the documentation does not say is under "Open questions" below and in `docs/open-questions.md` (Q31–Q42).

## Connection

| | |
|---|---|
| Base URL | `https://api.jneedcontur.net/client/api/` (ZD1: fixed in code per supplier code in `ZDDK_STORES`, never typed in the panel) |
| Authentication | Header `api-token: <token>` on every request. One token per account, shown in the store's panel; entered in the admin panel only (credential `apiToken`, stored encrypted). |
| Method | Every call is a `GET`, the order included (its fields and our key are in the query). The adapter never logs a URL; `supplier_calls` keeps the operation only. |
| IP allowlist | Per account in the store's panel. Holds the production server's IP only; "allow every IP" stays off (ZD1). |
| 2FA | The panel asks for it; code `108 2FA required` suggests API orders may need it (Q36). Turn it on before the pilot. |
| Timeouts | 15 s per request, 30 s for an order (ZD1). |
| Money | Prices are JSON numbers in `products` and `newOrder` (`0.0074375`, `1.26048`), decimal strings in `check` (`"1.2604800000000000"`) and `profile` (`"8788.683"`). The currency is never named; read as USD (Q35). |
| Rate limits | Not documented. Code `111 Try again after 1 minute`; the section's credit products carry `order_in_minute = 1` (Q41). |
| Sandbox | None. Every order spends the real balance. |

## Endpoints used

| Use | Call | Reply (documented example) |
|---|---|---|
| Balance (ZD9) | `GET profile` | `{ "balance": "8788.683", "email": "…" }` |
| Catalog (ZD3, ZD4) | `GET products` | An array of products (below) |
| Quote (S18 PQ1) | `GET products?products_id=<id>` | The same array, filtered |
| Order (ZD6) | `GET newOrder/<product id>/params?qty=<n>&playerId=<value>&order_uuid=<uuid>` | `{ "status": "OK", "data": { "order_id": "ID_…", "status": "accept", "price": 1.26048, "data": { "playerId": "…" }, "replay_api": [{ "replay": ["…"] }] } }` |
| Poll (ZD7) | `GET check?orders=[<uuid>]&uuid=1` | `{ "status": "OK", "data": [{ "order_id", "quantity", "data", "created_at", "product_name", "price": "1.2604800000000000", "status", "replay_api": ["…"] }] }` |

Not used: `products?base=1` (ids and names only), `check?orders=[ID_…]` (by the store's own id: our key is enough), `content/0` and `content/<category id>` (the category tree: **no reply example is documented**, so the adapter builds the categories from the products' own fields instead, below), the store's webhook (no signature: S25 Out).

### A product

| Field | Meaning | Adapter |
|---|---|---|
| `id` | Product id (number) | The offer id's first part |
| `name` | Name | Offer name; a value-list offer adds ` · <value>` |
| `price` | The account's price of one unit | `cost` × the offer's multiplier, exact (ZD4) |
| `base_price` | The price before the account's group discount | `originalCost`, same multiplier |
| `params` | **Arabic labels** of the order's fields (`["ادخل الايدي الاعب"]`, `["رقم الخط"]`, `["ID"]`), not keys | One label: one field `playerId` with that label. None or several: `fields_unsupported` (Q31) |
| `category_name`, `parent_id`, `category_img` | The category the product is listed in (`parent_id` 0 is the store's home page), its image as a path on the API host | `group`, `categoryId: category.<parent_id>`, the category's image `https://api.jneedcontur.net/<path>` |
| `available` | Sold now | `inStock` |
| `product_type` | `package` or `amount` | Not read: the shape of `qty_values` decides |
| `qty_values` | `null` (quantity 1), a list of the only quantities allowed (`["110","150"]`, decimals possible: `96.15`), or a range `{ "min", "max" }` (numbers or strings) | Below |

### Offers (ZD4)

| `qty_values` | Offers | `qty` sent | Our quantity | Cost |
|---|---|---|---|---|
| `null` | `<id>`, kind `direct`, `minQuantity = maxQuantity = 1` | `1` | 1 only | `price` |
| A list | `<id>:<value>` per distinct valid value (the value as written), kind `direct`, `minQuantity = maxQuantity = 1` | the value | 1 only | `price × value` |
| A range | `<id>@100`, kind `amount`, `minQuantity = ceil(min / 100)`, `maxQuantity = min(floor(max / 100), 1,000,000)`; left out when no whole unit fits | `quantity × 100` | 1 unit = 100 SYP | `price × 100` |

- A cost with a fraction of a micro-dollar after its multiplier is rounded up to the next micro-dollar (`usdUnitsOf(..., { roundUp: true })` in `zddk/decimal.ts`), for the sync and the quote alike, so it is never below what the supplier takes. The live catalog needs it: MTN credit is priced $0.0074375278 per pound, so every value has such a fraction, as has Syriatel's `price × 96.15` (S25 ZD4, amended 2026-11-05). A charge with such a fraction is not read.
- A JSON number is read from its shortest text (`String(n)`, exact for the store's figures, which have far fewer than 15 significant digits), never through floating-point arithmetic.
- An offer is kept `fields_unsupported` when its product has several `params` (Q31: the key of the second field is not known) or none: a product without a field may deliver codes, and the documentation gives no way to tell a code product before buying (Q31). Every sold offer is `direct` or `amount`; no `code` offer exists until Q31 is answered.
- A product whose row does not parse (an id that is not a number, a price that is not a decimal, a range whose bounds are not whole numbers in order) is left out.

### Categories (ZD3)

`listCategories` reads `GET products` and lists the distinct `parent_id`s above 0 as flat categories `category.<parent_id>`, named by `category_name`, with `productCount`, `inStockCount` and the first product's `category_img` (on `api.jneedcontur.net` only, rule IM1; the store writes its bare origin `https://api.jneedcontur.net/` for a category without an image, which is read as none). The categories' own parents are not read: `content/<id>`'s reply is undocumented. Once a live reply of `content/0` is shared, the tree's parents can be added.

## Orders

- **Key (ZD5):** `order_uuid` is a UUID of version 4 layout derived from the attempt id: the first 16 bytes of SHA-256(attempt id), version and variant bits set (`zddkOrderUuid`). Every send of an attempt carries the same key, whatever Q3 of the analysis answers (v4 only, or v7 accepted). Computed, never stored.
- **Idempotency:** documented: "the same `order_uuid` more than once returns the original order" (Q33 asks whether this holds after `reject`).
- **Fields:** only `playerId`, the one documented key (RN3: the recipient's normalised number for the section). Any other field key, an empty value or one over 128 characters is refused before sending.
- **Status mapping (ZD6, ZD7):** `accept` → `delivered` (the attempt's units; `chargedUsdUnits` from `price` when exact; the texts of `replay_api` as the delivery reference), `wait` → `pending` (`order_id` kept), `reject` → `failed_definitive` (`supplierCode: 'reject'`), any other status → `unknown`, answered.
- **Charge:** `price` is read as what the order cost (S18 CH1) for one-unit orders (packages and value lists). For an amount order it is not read until the pilot shows whether it is the order's total or one SYP's price: a unit price taken as the total would reprice the offer far too low through S18's charge check. The poll, which does not know the offer, reads it for one-unit orders only (an amount order is at least 10 units, D12).
- **Delivery reference (ZD8):** `replay_api` is `null`, `[{ "replay": [...] }]` in `newOrder` or `[...]` in `check`; its texts are joined with ` · `, control characters removed, at most 200 characters, and kept in the attempt's `result.reference`. The admin's order page shows it as the attempt's "رقم العملية"; the customer does not see it until the pilot shows it is an operator's operation number (S25 Acceptance).
- **Poll (ZD7):** one key per `check` call (the poll reads each attempt on its own schedule; S25 ZD7 allows up to 20 per call, an optimisation left for when the order volume needs it). An empty `data` is `unknown`, answered (not a health error). Several rows for one key, or no units to settle, are `unknown`, answered. The poll then re-sends the attempt with the same key (S16 RS1), which the store documents as returning the original order.

## Errors

The documentation lists the codes but not the reply that carries them (JSON shape, HTTP status): Q32. Until it is answered, **every reply outside the documented success shape is `unknown`** (a timeout, a lost connection, 4xx, 5xx, a 200 whose body is not `{ "status": "OK", … }`), so no refusal moves an order to another route; the poll and then the admin resolve it (ADR 0004). `zddk` has no `errors.ts` yet: it lands with the first definitive code. The planned mapping once Q32 gives the shape (from the analysis, S25 ZD6):

| Code | Meaning | Planned class |
|---|---|---|
| 120, 121 | Token missing or wrong | `failed_definitive` and a health alert |
| 122 | API use not allowed for the account | `failed_definitive` and an alert naming the setting |
| 123 | IP not allowed | `failed_definitive` and an alert naming the setting |
| 130 | Site under maintenance | `failed_definitive` (next route) |
| 100 | Insufficient balance | `failed_definitive` (next route) and a balance alert |
| 105, 110 | Quantity not available, product not available now | `failed_definitive` with `OUT_OF_STOCK_CODE` |
| 106, 112, 113 | Quantity not allowed, too small, too large | `failed_definitive` (a mapping fault the admin sees) |
| 107 | Player id blocked | `failed_definitive`, `inputRejected` |
| 108 | 2FA required | `failed_definitive` and an alert |
| 109 | Product deleted or not found | `failed_definitive`; the next sync drops it |
| 111 | Try again after 1 minute | `unknown`, `rate_limited`, `retryAt` a minute on |
| 114, 500 | Unknown error | `unknown` |

## Integration with this project

| | |
|---|---|
| Adapter | `ZddkAdapter({ store: 'jneedcontur', apiToken })`, registered in the worker's `SupplierRegistry` and the API's `SupplierAdaptersService`; `ADAPTERS_READY` includes `jneedcontur` (ZD2) |
| Capabilities | `catalog`, `categories`, `balance`, `offerQuote`. No `validatePlayer`, `webhooks`, `statement`, `platformStatus`, `offerWindow`, `account` |
| Routing | RT13: competes on cost like any route; RT14 precedence `wdgzone`, `fazercards`, `jneedcontur`, `fake`, `manual` |
| Units per order | A package or value-list route is usable only for a product whose most per order is 1 (RT4 `quantity_unsupported` otherwise): the catalog build sets `max_quantity` 1 on the products it routes there (credit packs, Jawaker, chat apps) |
| Reconciliation | No statement: S18 RC1's nightly charge check reads the poll's `price`, S13's supplier reconciliation the balance read before and after |
| Low balance | $10 by default (S25 Data) |
| Treasury | Place `supplier:jneedcontur`, account `supplier_prepaid:jneedcontur` (USD), funded by a manual treasury movement (S13) |
| Pause | Store switch `jneedcontur_paused` |
| Another zddk store | Add its code and host to `ZDDK_STORES` (with its own supplier code, credential and seeded row): TweetPin later, its own small spec |

## Fixtures

`packages/suppliers/src/zddk/fixtures/` follows the documentation's examples, with the section's products as the owner's account showed them on 2026-11-04 (MTN and Syriatel credit value lists, MTN bills and MTN Cash ranges). Every id, number, order id, email and reference is made up; no live reply was recorded. Replace a fixture with a sanitized live reply when one is shared.

## Live check (owner)

1. In the store's panel: 2FA on, the production server's IP in the allowlist, "allow every IP" off, webhook URL empty; rotate the token if the panel allows (it was shown in clear during the analysis).
2. In the admin panel's supplier page: enter the token, "test" (one balance read), "sync now". Check the catalog and the categories with images, the section's offers (`1520:<value>`, `2049@100`, `1994@100`) and their costs against the store's panel.
3. Fund about $20 by a treasury movement; one MTN credit of 1,000 SYP to the owner's own line, then one Jawaker pack (S25 Acceptance). Compare the cost, the balance before and after, and the delivery reference on the order page.

## Open questions

The supplier's facts are Q31–Q42 in `docs/open-questions.md`. What this adapter assumes until they are answered:

- **Q31** (fields): one field only, sent as `playerId`; no code products.
- **Q32** (error replies): every reply outside the success shape is `unknown`; no definitive code.
- **Q34** (`check` for an unknown key): `unknown`, answered; the poll re-sends with the same key.
- **Q35** (currency): USD.
- Not in `docs/open-questions.md`: the reply of `content/<id>` (the tree's parents), and whether `price` in `newOrder`/`check` is the total for a range product. Both are read from the pilot's first live replies.
