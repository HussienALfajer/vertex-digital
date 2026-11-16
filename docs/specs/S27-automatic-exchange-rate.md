# S27 — Automatic exchange-rate updates (F46)

Status: Approved · Date: 2026-11-16 · Scope: `docs/product/v1-scope.md` §F46 · ADRs: 0003, 0017, 0019, 0041 (new)

## Summary
Today the admin types the store's one SYP-per-USD rate in the panel (S03, ADR 0017). The parallel market moves daily, so the rate goes stale between the owner's edits. S27 reads the rate from public sources the admin configures (public Telegram channels and the "الليرة اليوم" site), applies small moves that two sources agree on by itself, and sends every other move to the owner's Telegram bot as an approve or reject card. The store keeps **one rate** for every customer, merchant, shop and city. The money guarantees of ADR 0003 and 0017 are unchanged: a customer never gets a rate they did not see, and the store never credits more than the pounds received are worth.

## Owner decisions (2026-11-16 interview)
1. **Sources:** public Telegram channels the owner trusts, read from their public web preview (`https://t.me/s/<channel>`), and the "الليرة اليوم" site (`sp-today.com`) public pages. No WhatsApp (no official read API; unofficial clients risk a ban). No bot inside other people's groups. The sources are panel data, not repository content.
2. **Apply policy:** automatic with conditions. A move is applied without the owner when at least two fresh sources agree within 1% and the move is at most 2%. Otherwise a suggestion goes to the owner.
3. **Which figure:** the source's **sell** price of the dollar (the higher figure, e.g. 132 of 131.50 / 132), the one that protects the store.
4. **Polling:** every 15 minutes. When every source is silent, the last rate stays and the owner is alerted after 6 hours. Nothing is paused; the 48-hour panel banner (FX7) stays.
5. **Sources disagree** by more than 1%: no automatic change; the card shows every figure and proposes the **highest**, which the owner may edit in the panel.
6. **Telegram approval:** a suggestion up to 5% from the current rate can be approved from Telegram; above 5% only in the panel, with re-authentication and the typed confirmation of FX2.
7. **One rate for all** (owner, 2026-11-16, after first asking for per-city rates): no city or zone rates. The sources read the Damascus market figure (or the source's general figure).

## In scope / out of scope
- In:
  - The rate's history in `exchange_rates`, with who or what set it (admin, automatic, approved suggestion).
  - Rate sources: a public Telegram channel or a "الليرة اليوم" page, a parser setting, a test read in the panel, enable and disable.
  - A worker job every 15 minutes that reads the sources, stores observations, and applies or suggests a rate.
  - Suggestions with a Telegram card (approve up to 5%, reject) and a panel page.
  - Rate settings (append-only versions): the automatic switch, the thresholds and windows below.
  - Alerts: no fresh figure, a broken source, an automatic change (silent notice), a suggestion card.
- Out (later or never):
  - Per-city or per-account rates (declined by the owner, 2026-11-16).
  - WhatsApp, any user-account (MTProto) Telegram client, reading private groups, or a bot in someone else's group.
  - A buy and sell spread inside the store (one rate, as today).
  - Global FX APIs (they publish the official or mid-market rate, not the Syrian parallel market).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the rate, history, sources, observations, suggestions, settings | Admin | The admin |
| Set the rate or the display step by hand | Admin, re-authentication (FX1, FX2) | The admin |
| Add, edit, enable, disable, archive a source | Admin, re-authentication | The admin |
| Test-read a source | Admin, rate limited | The admin |
| Change rate settings, turn automatic updates on | Admin, re-authentication | The admin |
| Approve a suggestion ≤ 5%, reject any suggestion | Telegram (linked chat) or panel | The admin |
| Approve a suggestion > 5% | Admin, re-authentication, typed confirmation | The admin |
| Turn automatic updates off | Telegram (confirm button) or panel | The admin |

## Data

### `exchange_rates` (exists; append-only; amended)
- Adds `origin` enum `rate_origin` (`admin`, `auto`, `suggestion`; existing rows backfilled `admin`) and `suggestion_id` → `rate_suggestions.id` null.
- `admin_id` becomes nullable: required for `admin` and `suggestion`, null for `auto` (check).
- An automatic or approved row copies the current `display_step_syp_units`.
- The store-wide advisory lock of S03 serializes every change, automatic ones included, so FX2's and AU's comparisons always use the rate being replaced.

### `rate_sources` (new; owner: `rates`; archived)
- `id`, `kind` enum `rate_source_kind` (`telegram_channel`, `sp_today_page`), `label` text (2–40, shown on cards), `handle` text: the channel username (`^[A-Za-z0-9_]{5,32}$`) or the sp-today page path (`^/[a-z0-9/_-]{1,120}$`, host fixed in code), `parser` jsonb validated by `rateSourceParserSchema`:
  - `cityKeyword` text null: the line must contain it (e.g. «دمشق»), for channels that post several cities;
  - `sellKeyword` text (default «مبيع»): the figure is the first number after it on that line;
  - `unit` enum `new_syp` | `old_syp` (old pounds are divided by 100, ADR 0003);
- `enabled` boolean, `created_at`, `updated_at`, `archived_at` null. Unique `(kind, handle)` among non-archived rows.
- Hosts are fixed in code (`t.me`, `sp-today.com`); a source never names a URL host.

### `rate_observations` (new; owner: `rates`; append-only; purged after 90 days)
- `id`, `source_id`, `fetched_at`, `posted_at` timestamptz null (the post's time; the page's update time when shown, else null), `status` enum (`ok`, `no_match`, `fetch_failed`, `out_of_range`), `syp_per_usd` numeric(12,4) null (after the unit conversion), `excerpt` text null (≤ 300 characters of the matched line, for the owner to check), `error_code` text null.
- Index `(source_id, fetched_at desc)`. One row per source per poll.

### `rate_suggestions` (new; owner: `rates`)
- `id`, `proposed_syp_per_usd` numeric(12,4), `base_rate_id` → `exchange_rates.id` (the current rate when proposed), `change_percent` numeric (exact), `reason` enum (`single_source`, `sources_disagree`, `move_too_large`, `drift_too_large`, `auto_off`), `observation_ids` uuid[], `status` enum `rate_suggestion_status` (`pending`, `approved`, `rejected`, `superseded`, `expired`), `decided_at`, `decided_channel` (`panel`, `telegram`) null, `admin_id` null, `applied_rate_id` null, `created_at`.
- At most one `pending` (partial unique index). A newer suggestion supersedes the pending one; a pending suggestion expires after 6 hours.

### `rate_settings` (new; owner: `rates`; append-only versions, newest in force)
- `auto_enabled` boolean (default **false**: the owner turns it on after adding sources), `auto_max_move_bps` (200 = 2%), `agreement_max_spread_bps` (100 = 1%), `min_agreeing_sources` (2, range 2–5), `drift_window_hours` (24) with `drift_max_bps` (200), `min_move_bps` (25 = 0.25%: smaller moves are ignored), `freshness_minutes` (180), `silent_alert_hours` (6), `telegram_approve_max_bps` (500, never above 500), `poll_minutes` (15, range 10–60), `admin_id`, `created_at`.

### Contracts
- `rates.ts`: `rateSourceSchema`, `rateSourceParserSchema`, `rateObservationSchema`, `rateSuggestionSchema`, `rateSettingsSchema`; `exchangeRateRecordSchema` gains `origin`.
- `money.ts`: `basisPointsBetween(a, b)` exact, and `parseSourceFigure(text, parser)` (pure; Arabic-Indic and Persian digits normalised, thousands separators removed, unit conversion) with tests.
- Error codes: `RATE_SOURCE_INVALID`, `RATE_SUGGESTION_STATE_CONFLICT`, `RATE_SUGGESTION_TOO_LARGE_FOR_TELEGRAM`.

## States and rules

### Manual changes (S03, kept)
- FX1–FX9 are unchanged. A manual change is allowed at any time, supersedes a pending suggestion, and the drift window (AU5) then counts from it. Every reader of the current rate (deposits, wallet, orders, merchant tools, shops in `store` mode, reconciliation) keeps reading the newest row: no reader changes.

### Reading sources
- SR1. The job `rates.poll` runs every `poll_minutes` (singleton). For each enabled source it fetches the page with a 10-second timeout and a fixed user agent naming the store's public site (no personal data), one request per source per run, no retry within the run, no redirect to another host.
- SR2. Telegram: `https://t.me/s/<handle>`; posts are scanned newest first; the first line containing `cityKeyword` (when set) and `sellKeyword` followed by a number gives the figure; its time is the post's `datetime`. sp-today: `https://sp-today.com<handle>`; the figure is the dollar's sell value (of the row matching `cityKeyword` when set); `posted_at` is the page's update time when shown, else null.
- SR3. A figure outside ±20% of the current rate is stored as `out_of_range` and never used (catches old-pound figures, typos and wrong posts). The first `out_of_range`, or three consecutive `no_match` / `fetch_failed` of a source, send one alert («مصدر لا يُقرأ») until it reads `ok` again.
- SR4. A figure is **fresh** when `posted_at` is within `freshness_minutes`; with no `posted_at`, when the figure was first seen (changed from the source's previous `ok` figure) within `freshness_minutes`. Each source contributes at most its newest fresh figure.
- SR5. Keywords are plain text matched literally; no admin input is ever evaluated as a pattern.

### Deciding (after each poll)
- AU1. With no fresh figure: nothing. When no source has had a fresh figure for `silent_alert_hours`, one alert («لا سعر جديد من المصادر») until one returns.
- AU2. Candidates = the fresh figures. `spread = (max − min) / min`. `proposed = max` (decision 5: the highest protects the store).
- AU3. `change = |proposed − current| / current`. A change below `min_move_bps` does nothing (no row, no card).
- AU4. **Automatic apply** when all hold: `auto_enabled`; at least `min_agreeing_sources` candidates; `spread ≤ agreement_max_spread_bps`; `change ≤ auto_max_move_bps`; and AU5. It writes an `auto` row with the current step and the audit entry, and queues a silent Telegram notice («السعر ← 132.00 (+0.8%) من مصدرين»). A pending suggestion is superseded.
- AU5. **Drift cap:** the proposed rate must also be within `drift_max_bps` of the rate in force `drift_window_hours` ago (or the oldest rate if younger). A chain of small automatic moves therefore never shifts the rate more than 2% in 24 hours without the owner.
- AU6. Otherwise (one candidate, spread above 1%, change above 2%, drift above 2%, or automatic updates off with a move ≥ `min_move_bps`) a **suggestion** is created with its reason. It supersedes a pending one only when its value differs from it by at least `min_move_bps`; otherwise the pending one stays (no repeated cards).
- AU7. A decision run is safe twice: it runs under the rate advisory lock; the suggestion insert respects the one-pending index; an automatic row is skipped when the current rate is newer than the run's start.

### Suggestions
- SG1. A card goes to the linked Telegram chat with the current and proposed rate, the change and the 24-hour drift, and each figure with its source label and age. Buttons: «اعتماد» (only when `change ≤ telegram_approve_max_bps`), «رفض», «فتح في اللوحة».
- SG2. Approving recomputes the change against the rate **at that moment**. If the suggestion is no longer `pending`, or the change now exceeds the Telegram cap, it answers `RATE_SUGGESTION_STATE_CONFLICT` / `RATE_SUGGESTION_TOO_LARGE_FOR_TELEGRAM` and the card says why. Approval writes a `suggestion` row (admin, channel recorded).
- SG3. In the panel the admin may approve the proposed value or edit it before approving. A value more than 5% from the current rate needs the typed confirmation (FX2) and re-authentication, as any manual change.
- SG4. Rejecting needs no reason. For 6 hours after a rejection, a new suggestion is made only for a value at least `min_move_bps` away from the rejected one.
- SG5. A pending suggestion expires after 6 hours (job `rates.expire-suggestions`, hourly); its card is edited to «انتهت».

### Settings and switch
- ST1. Automatic updates are off until the owner turns them on in the panel (re-authentication). Telegram's «إيقاف التحديث التلقائي» turns them off after a confirm button (ADR 0019's stop-only rule). Suggestions continue while automatic updates are off.
- ST2. Bounds: `auto_max_move_bps` 50–300, `agreement_max_spread_bps` 25–300, `drift_max_bps` 100–500, `telegram_approve_max_bps` 100–500, `freshness_minutes` 30–720, `silent_alert_hours` 1–48.

## Money flows
None new. No journal, posting or account kind is added. SYP deposits keep the four-posting journal of ADR 0017, converted with FX6 (`floorToWholeCents(sypToUsd(syp, rate, 'down'))`) at the rate row stored on the deposit. Idempotency keys, the 15-minute lock, the fixed rate after the first valid submission (SC9) and the reversal rules are unchanged. An automatic change affects only new quotes and displays, as a manual one does (FX4).

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/admin/rates` (exists) | Admin | cursor | `{ current, stale, pendingSuggestion, autoEnabled, history page }` (rows carry `origin`) | — |
| `POST /api/admin/rates` (exists) | Admin, re-authentication | `changeRateSchema` | `201` rate record | S03's |
| `GET /api/admin/rate-sources` · `POST` · `PATCH /:id` · `POST /:id/archive` | Admin; writes re-authentication | `rateSourceSchema` fields | source with its last observations | `RATE_SOURCE_INVALID`, `VALIDATION_FAILED` |
| `POST /api/admin/rate-sources/test` | Admin, 10 per minute | `{ kind, handle, parser }` | `{ status, sypPerUsd, postedAt, excerpt }` (stores nothing) | `RATE_SOURCE_INVALID`, `RATE_LIMITED` |
| `GET /api/admin/rate-suggestions` | Admin | `status?`, cursor | page | — |
| `POST /api/admin/rate-suggestions/:id/approve` | Admin, re-authentication | `{ sypPerUsd?, rateConfirmation? }` | rate record | `RATE_SUGGESTION_STATE_CONFLICT`, `RATE_CONFIRMATION_REQUIRED`, `RATE_CONFIRMATION_MISMATCH` |
| `POST /api/admin/rate-suggestions/:id/reject` | Admin | — | suggestion | `RATE_SUGGESTION_STATE_CONFLICT` |
| `GET /api/admin/rate-settings` · `POST` | Admin; write re-authentication | `rateSettingsSchema` | settings | `VALIDATION_FAILED` |
| Telegram webhook (exists) | Linked chat | callback data `rs:<id>:approve\|reject`, `rates:auto-off` | card edit | as SG2 |

Customer, merchant and shop routes are unchanged. `openapi:export` and the admin client are regenerated.

## Jobs and integrations
- `rates.poll` (cron every `poll_minutes`, singleton): SR1–SR5, then AU1–AU7. Network failures are observations, never job failures. Outbound hosts limited to `t.me` and `sp-today.com` in code.
- `rates.expire-suggestions` (hourly): SG5.
- `rates.purge-observations` (daily 04:40 Damascus): rows older than 90 days.
- Telegram (ADR 0019 outbox): suggestion card, automatic-change notice (silent), alerts (source broken, no fresh figure). The daily summary gains a line: the rate, changes today and their origin.
- Local development: `RATE_FEED=fake` makes the fetcher read `storage/rate-feed-fake/<kind>/<handle>.html`; a CLI `pnpm --filter @vertex-digital/worker rates:fake-post --channel <handle> --text <text>` writes a post with the current time. Tests use recorded, sanitized page fixtures.

## Screens

### Admin (Arabic, RTL)
- **`/rates`** (exists) gains: the origin of each history row («يدوي», «تلقائي», «اقتراح معتمد»); the automatic switch state; the pending suggestion with approve (editable value) and reject; a "المصادر" section with each source's last three observations (value, age, excerpt), health, enable switch, edit and "تجربة القراءة".
- **`/rates/sources/new`** and edit: kind, label, channel or page, city keyword, sell keyword (default «مبيع»), unit; "تجربة القراءة" shows the figure and the matched excerpt before saving.
- **`/rates/settings`**: the automatic switch and the thresholds of ST2 with their meaning in one line each.
- Loading, empty («لا مصادر بعد: أضف قناة أو صفحة») and error states as the S03 pages.

### Store
- No change.

## Audit and notifications
- `exchange_rate.changed` gains `origin` (`admin`, `auto`, `suggestion`); automatic rows are audited with actor `system`, channel `worker`, and the observation ids.
- `rate_source.created|updated|archived`, `rate_settings.changed`, `rate_suggestion.approved|rejected` (channel `panel` or `telegram`).
- Telegram as in Jobs. Customers are not notified of rate changes (as today).

## Abuse and fraud
| Threat | Control |
|---|---|
| A source channel is hacked or posts a fake rate | Two sources must agree within 1%; one source only suggests; a move above 2% only suggests; ±20% range check |
| A slow ratchet down (more USD per pound) across many polls | AU5's 24-hour drift cap of 2%; every automatic change is a Telegram notice and an audited row |
| A stolen Telegram account | It can approve only a source-made suggestion of at most 5% (it cannot type a value), reject, or turn automatic updates off; never on, never an edit |
| Quote gaming around a change | Unchanged: the 15-minute lock, the submitted `rateId` check, the fixed rate after the first valid submission (SC9) |
| Server-side request forgery through a source | Hosts fixed in code; the handle validated by a strict pattern; redirects to other hosts refused |
| Parser abuse (ReDoS) | Keywords are literal text; no admin regular expressions |
| Being blocked by a source | One request per source per poll; failures alert, never retry in a loop |

## Edge cases
1. All sources silent: the last rate stays; alert after 6 hours; the 48-hour banner as before.
2. A source posts in old pounds (13,200): parsed with `unit = old_syp`; a wrong unit gives `out_of_range` and an alert.
3. A post lists several cities with buy and sell: `cityKeyword` picks the line; the first number after «مبيع» on that line counts.
4. The admin changes the rate by hand while a suggestion is pending: the suggestion is superseded; the next poll compares with the new rate.
5. The owner approves on Telegram after an automatic change: SG2 recomputes; a superseded suggestion's card says so.
6. Two polls overlap (a slow run): the singleton queue prevents it; the advisory lock and AU7 make a duplicate decision a no-op.
7. Automatic updates off: suggestions continue; nothing is applied without the owner.
8. A rate change lands while a customer holds a quote: the quote keeps its locked rate (FX4), as with a manual change.
9. sp-today removes a row or changes its layout: `no_match` and an alert after three runs.
10. A channel's public preview is disabled: `fetch_failed`/`no_match`; the test read says so before saving.
11. No rate exists yet (fresh install): automatic updates never create the first rate; the admin sets it (FX8), so the ±20% check always has a base.

## Open questions
- Q43 (owner): the exact Telegram channels to trust for the Damascus (general) rate. Recommendation: two or more, each checked with "تجربة القراءة"; automatic updates stay off until two sources work.
- Q44 (owner): whether "الليرة اليوم" allows automated reading for a commercial store. Checked on 2026-11-16: its `robots.txt` allows its public pages and disallows `/api/`; no public API, licence or terms on automated use were found (its terms page answered 404). Recommendation: ask them in writing and keep the source disabled until they agree; Telegram channels alone are enough to start.
- Unverified: Telegram's terms for reading `t.me/s/` previews automatically (no `robots.txt` was served on 2026-11-16). The preview is public and needs no account; the request rate is one page per channel per 15 minutes.

## Acceptance
- Owner's browser check (local, `RATE_FEED=fake`, Telegram `log` transport):
  1. `/rates`: the rate is 130 (set by hand). Add two fake channels posting «دمشق مبيع 131» and «دمشق مبيع 131.5»; test-read each; turn automatic updates on (re-authentication).
  2. Run a poll: the rate becomes 131.5 («تلقائي»), with a notice in the Telegram log.
  3. Post «دمشق مبيع 140» on one channel only: a suggestion card without «اعتماد» (above 5%); approve it in the panel with the typed confirmation.
  4. Post 134 on both channels: a suggestion (move above 2%); press «اعتماد» through `telegram:fake-update --tap`: the rate becomes 134 («اقتراح معتمد»).
  5. Create a SYP deposit before a change and submit after it within 15 minutes: the locked rate is kept.
- Tests:
  - Unit: `parseSourceFigure` (digits, separators, old pounds, city line, no match), `basisPointsBetween`, the AU2–AU6 decision table (one source, disagreement, move and drift at and just above the thresholds, min move).
  - DB: one-pending index, `admin_id` check per origin, append-only grants, concurrent manual and automatic changes under the lock.
  - API: every new route (success, 401, 403 for a customer session, validation), re-authentication on writes, the Telegram cap re-checked at approval time.
  - Worker: the poll against recorded fixtures (Telegram preview and sp-today pages), the SSRF host guard, broken-source and silent alerts sent once, idempotent re-runs.
  - E2E and RTL screenshots: `/rates` with sources and a suggestion, the source form with a test read, settings.

## Implementation notes
- One PR is enough: contracts, migration, the `rates` sources, suggestions and settings in the api, the worker poll and fetchers, Telegram cards, the fake feed, admin screens.
- Update `docs/architecture.md` (`rates` jobs), `.env.example` (`RATE_FEED`), and the commands table for `rates:fake-post`.
