# S14 — Content and live activity (F21, F25)

Status: Approved · Date: 2026-10-11 · Scope: `docs/product/v1-scope.md` §F21, §F25 (§F12 home banners and activity) · ADRs: 0002, 0008, 0011, 0012, 0015, 0016, 0022, 0026, 0028

## Summary
The store has no FAQ, no terms, privacy or refund pages, no way to announce anything and nothing on the home page that the admin can change; S09 left banners and live activity to S14. S14 adds **content edited in the panel and published to the store**: four fixed pages (terms, privacy, refund, about) and an FAQ in sections, written in a limited Markdown, saved as drafts, previewed as the store shows them and published as versions; **home banners** (one 2:1 image, an optional internal link and an optional schedule, at most 5 enabled, rotating); and one **announcement bar** on every store page (scheduled, dismissible on the device). It adds **live activity**: the last 10 real deliveries, at least 5 minutes old, with the game, the pack and the measured delivery time, on the home page and per game on the game page, hidden while fewer than 5 real deliveries happened in the last 24 hours, and switchable off in the panel. Sign-up states that creating an account accepts the terms and privacy policy, and the account keeps the versions in force (owner, 2026-10-11).

## In scope / out of scope
- In:
  - Pages `terms`, `privacy`, `refund`, `about` (rules PG): draft, preview, publish, version history, restore a version into the draft; public at `/terms`, `/privacy`, `/refund`, `/about` once published.
  - FAQ (rules FQ): sections and questions with order, archive and restore; the whole FAQ published as one snapshot; public at `/faq` as an accordion; links from the footer and the support pages.
  - Limited Markdown (rules MD): one parser in `packages/contracts`, one renderer in `packages/ui`, used by the store and the panel preview.
  - Home banners (rules BN) and the announcement bar (rules AN).
  - Live activity (rules LA) with its switch (`content_settings`).
  - Terms acceptance at sign-up (rules TA); the accepted versions on the admin customer profile.
  - Store: footer links, the sitemap, the cached reads under a new `content` tag refreshed by the existing `store.revalidate` job.
- Out (later or never):
  - Admin-created pages with free URLs: not in V1 (owner, 2026-10-11); the four pages are fixed.
  - Images, tables, raw HTML or external links inside pages and FAQ answers: not in V1 (owner, 2026-10-11).
  - Per-game FAQ questions on the game page: not in V1 (owner, 2026-10-11).
  - Aggregated activity counters ("120 orders today"): not in V1 (owner, 2026-10-11).
  - A required "I agree" checkbox, or asking customers to accept new terms: not in V1 (owner, 2026-10-11).
  - Separate phone and desktop banner images: not in V1 (owner, 2026-10-11).
  - Several announcements at once, or a rotating announcement: not in V1 (owner, 2026-10-11).
  - Category pages (mentioned in S09 as possible here): not in V1; the home page keeps its category sections.
  - The texts of the four pages: written in a separate session before the pilot from the project's rules and reviewed by the owner (Q10 stays open for launch, owner 2026-10-11). S14 ships the pages unpublished.
  - Public history of past page versions: not in V1; the panel keeps them.
  - English content: Phase 4 (ADR 0012).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the site content (announcement, live banners, published page titles, FAQ presence), a published page, the published FAQ, the live activity | Public | Anyone |
| Read drafts, versions, the FAQ working copy, banners, announcements, the content settings, the activity preview | Admin | The admin |
| Save a page draft, publish a page, restore a version into the draft | Admin (no re-authentication, owner 2026-10-11) | The admin |
| Create, edit, reorder, archive and restore FAQ sections and questions; publish the FAQ | Admin | The admin |
| Create, edit, enable, disable, reorder, archive and restore banners and announcements; upload a banner image | Admin | The admin |
| Turn live activity on or off | Admin (no re-authentication, owner 2026-10-11) | The admin |
| Record the accepted terms and privacy versions at sign-up | Customer sign-up (Better Auth hook) | System |

## Data
All new tables are owned by the api `content` module. Admin ids carry no foreign key, as `deposit_settings.admin_id`.

### `content_page` enum
`terms`, `privacy`, `refund`, `about` (`CONTENT_PAGES` in `packages/contracts/src/content.ts`).

### `content_page_drafts` (new; one row per page, seeded; updated in place)
- `page` `content_page` primary key.
- `title` text not null: 2–80 characters. Seeded "الشروط والأحكام", "سياسة الخصوصية", "سياسة الاسترداد", "من نحن".
- `body` text not null default `''`: 0–30,000 characters (MD rules apply when not empty).
- `revision` integer not null default 0: +1 on every save (PG3).
- `updated_at` timestamptz, `updated_by` uuid null (the admin).

### `content_page_versions` (new; append-only)
- `id` uuid; `page` `content_page` not null; `version` integer not null (1, 2, … per page); unique `(page, version)`.
- `title` text not null; `body` text not null (1–30,000 characters): the published copy.
- `draft_revision` integer not null: the draft revision that was published (PG5).
- `admin_id` uuid not null; `published_at` timestamptz not null default `clock_timestamp()`.
- Index `(page, version desc)`. Append-only grants and trigger like the other append-only tables.

### `faq_sections` (new; archived, never deleted)
- `id` uuid; `title` text not null (2–60 characters); `position` integer not null; `archived_at`; `created_at`, `updated_at`.

### `faq_items` (new; archived, never deleted)
- `id` uuid; `section_id` uuid not null → `faq_sections`; `question` text not null (5–200 characters); `answer` text not null (1–3,000 characters, MD rules); `position` integer not null (within the section); `archived_at`; `created_at`, `updated_at`.
- Index `(section_id, position)`.

### `faq_publications` (new; append-only)
- `id` uuid; `faq_revision` integer not null (FQ6); `sections` jsonb not null: the snapshot `[{ id, title, items: [{ id, question, answer }] }]` in order, unarchived only, sections without items left out; `admin_id` uuid not null; `published_at` timestamptz not null default `clock_timestamp()`.

### `banners` (new; archived, never deleted)
- `id` uuid; `image_file_id` uuid not null → `stored_files` (kind `catalog_image`, BN2); `alt_text` text not null (2–120 characters); `link_path` text null (MD4); `starts_at`, `ends_at` timestamptz null, check `ends_at > starts_at` when both are set; `enabled` boolean not null default false; `position` integer not null; `archived_at`; `created_at`, `updated_at`.
- Checks: not `enabled` when `archived_at` is set; `link_path` null or matching the MD4 pattern (the same check on `announcements.link_path`).

### `announcement_tone` enum
`info`, `warning`.

### `announcements` (new; archived, never deleted)
- `id` uuid; `text` text not null (5–140 characters, plain text, no Markdown); `link_path` text null (MD4); `tone` `announcement_tone` not null default `info`; `starts_at`, `ends_at` timestamptz null, same check as banners; `enabled` boolean not null default false; `revision` integer not null default 1 (+1 when the text, link or tone changes, AN4); `archived_at`; `created_at`, `updated_at`.
- Unique partial index on `(enabled)` where `enabled and archived_at is null`: at most one enabled announcement (AN2). Check: not `enabled` when `archived_at` is set.

### `content_settings` (new; one row, `id = 1`, seeded)
- `live_activity_enabled` boolean not null default true (LA6); `faq_revision` integer not null default 0 (FQ6); `updated_at`.

### `customers` (extended)
- `terms_version_id` uuid null → `content_page_versions`; `privacy_version_id` uuid null → `content_page_versions` (TA2). Null for customers who signed up before the page was published.

### `orders` (index only)
- Partial index `(delivered_at desc)` where `status = 'delivered' and not is_test`, for the store-wide activity read (LA2). The per-game read uses the S08 index on `(product_id, delivered_at desc)` through the game's products.

### Audit entity types (added to `AUDIT_ENTITY_TYPES`)
`content_page`, `faq_section`, `faq_item`, `faq`, `banner`, `announcement`, `content_settings`.

### Contracts (`packages/contracts/src/content.ts`)
- `CONTENT_PAGES`, `ANNOUNCEMENT_TONES`, the limits below as constants, `linkPathSchema` (MD4), `richTextSchema(max)` (MD1–MD3), `parseRichText(source)` returning the allowed nodes (MD5), `bannerState(banner, now)` and `announcementState(…)` (BN4), `activityVisible(countLast24h)` (LA3), `floorToFiveMinutes(date)` (LA4), `formatDeliveryDuration(seconds)` (LA5). Pure functions at 100% coverage.
- Schemas for every request and response below.
- Constants (not editable in the panel, owner 2026-10-11): `ACTIVITY_DELAY_MINUTES = 5`, `ACTIVITY_ITEMS = 10`, `ACTIVITY_WINDOW_HOURS = 24`, `ACTIVITY_MINIMUM = 5`, `BANNERS_ENABLED_MAX = 5`, `BANNERS_MAX = 20`, `ANNOUNCEMENTS_MAX = 20`, `FAQ_SECTIONS_MAX = 12`, `FAQ_ITEMS_PER_SECTION_MAX = 30`.

## States and rules

### Limited Markdown
- MD1. Page bodies and FAQ answers are CommonMark limited to: paragraphs, line breaks, `##` and `###` headings (a `#` heading is refused, since the page title is the only `h1`), bold, italic, bulleted and numbered lists (two levels), block quotes, and links whose target passes MD4.
- MD2. Refused with `VALIDATION_FAILED` and `details.body` (or `details.answer`) as `{ line, reason }` for each problem: raw HTML (any `<` that opens a tag or an autolink), images, tables, code blocks, horizontal rules, a link target that fails MD4, a `#` heading. The panel shows each problem next to its line.
- MD3. The source text is stored as written; nothing is rewritten on save.
- MD4. **Internal links only** (`linkPathSchema`, owner 2026-10-11): a path starting with `/` and not `//`, at most 200 characters, made of `A–Z a–z 0–9 - . _ ~ /`, optionally followed by `#` and a fragment of `A–Z a–z 0–9 - _`. No scheme, host, query string or `..` segment. The same schema is used for banner and announcement links.
- MD5. Rendering: `parseRichText` in `packages/contracts` produces the allowed nodes only; the `RichText` component in `packages/ui` (a server-compatible component, no `'use client'`) maps them to elements with the design-system typography. Anything the parser does not produce is never rendered, so even a row written around the API cannot inject markup. Links render as `next/link`-compatible anchors on the store (no `target`), headings get stable ids for fragments.

### Pages
- PG1. The four pages always exist as drafts (seeded). A page is **published** once it has a version; it then stays published (no unpublish in V1): changes are new versions.
- PG2. The store shows the newest version of a published page at its route with "آخر تحديث: <date>" (the version's `published_at`, `Asia/Damascus`, Latin digits). An unpublished page answers 404 and is linked nowhere (footer, sign-up, sitemap).
- PG3. Saving a draft sends the title, the body and the draft's `revision` as last read; a different stored revision is `CONTENT_STALE` (another tab saved first), and the panel offers to reload. A save increments the revision.
- PG4. Preview renders the current draft with `RichText` in a frame styled as the store (dark, phone and desktop widths), from the panel's own copy of what it is editing, before or after saving.
- PG5. Publishing sends the draft `revision` that was previewed; a different stored revision is `CONTENT_STALE`. The body must be non-empty and pass MD1–MD2. When the title and body equal the newest version's, it is `CONTENT_UNCHANGED`. Publishing writes the next version, its audit entry and the store refresh (CP1) in one transaction.
- PG6. "استعادة إلى المسودة" copies a version's title and body into the draft (a save, PG3); it publishes nothing.

### FAQ
- FQ1. Sections and questions are a working copy edited freely; the store shows only the newest **publication** (owner, 2026-10-11).
- FQ2. Limits: at most 12 unarchived sections and 30 unarchived questions per section (`CONTENT_LIMIT_REACHED`).
- FQ3. Archiving a section hides it and its questions from the next publication; its questions keep their own archive state. Restoring a section is refused under the section limit (`CONTENT_LIMIT_REACHED`); restoring a question under an archived section is `PARENT_ARCHIVED`. A question can move to another unarchived section by editing it (placed last there).
- FQ4. Order: `PUT …/faq/order` takes the full ordered list of unarchived section ids and, per section, its unarchived question ids; any other set is `VALIDATION_FAILED`. Positions are rewritten in one transaction.
- FQ5. The public FAQ is the snapshot: sections in order, each with its unarchived questions in order; a section with no question is left out. With no publication, or one with no question, `/faq` answers 404 and is linked nowhere.
- FQ6. Every FAQ change (create, edit, archive, restore, order) increments `content_settings.faq_revision` in its transaction. The panel shows "تعديلات غير منشورة" while the working revision is ahead of the newest publication's. Publishing sends the revision it previewed (`CONTENT_STALE` otherwise); a revision equal to the newest publication's is `CONTENT_UNCHANGED`.
- FQ7. The FAQ page renders each question as a native `<details>` with the answer through `RichText` (no client JavaScript); each question has a stable fragment (`/faq#q-<id prefix>`) so the admin can link to it.

### Banners
- BN1. A banner is one image, an alt text, an optional internal link (MD4), an optional start and end, an enabled switch and a position (owner, 2026-10-11).
- BN2. **Image:** uploaded through `POST /api/admin/content/banners/image` with the S06 CT10 limits (PNG, JPEG or WebP, up to 5 MB and 25 megapixels, metadata stripped), at least 1200 × 600 px and a width-to-height ratio of 2:1 within 2% (`IMAGE_INVALID` with `details.reason` `too_small` or `ratio`); stored as a `catalog_image` (WebP within 1600 px, so 1600 × 800) and served by the existing public image route with its widths (S09 SF5). The panel shows the 2:1 guide and the minimum size before upload.
- BN3. Limits: at most 20 unarchived banners and 5 enabled at a time; enabling a sixth is `CONTENT_LIMIT_REACHED` (owner, 2026-10-11).
- BN4. State (computed, `bannerState`): `disabled` (not enabled), `scheduled` (enabled, `starts_at` in the future), `live` (enabled, started or no start, not ended), `ended` (enabled, `ends_at` past), `archived`. Times are entered and shown in `Asia/Damascus`. A start or end in the past is refused on save (`VALIDATION_FAILED`), except an unchanged one.
- BN5. The store shows the `live` banners by position, at most 5. Archiving an enabled banner disables it in the same transaction; a restored banner comes back disabled at the last position.
- BN6. Order: `PUT …/banners/order` with the full ordered list of unarchived banner ids (`VALIDATION_FAILED` otherwise).

### Announcement bar
- AN1. An announcement is a plain text of 5–140 characters, an optional internal link (MD4, shown as "التفاصيل"), a tone (`info` or `warning`, the design system's callout tones), an optional start and end, and an enabled switch (owner, 2026-10-11). Same time rules as BN4.
- AN2. At most one announcement is enabled. Enabling one disables the enabled one in the same transaction (both audited); the panel's confirm names the one being replaced. At most 20 unarchived (`CONTENT_LIMIT_REACHED`).
- AN3. The store shows the enabled announcement while it is `live` (BN4 states) on every page, under the header, after the S05 stop banner (SW9) and the S12 frozen banner, which keep their places.
- AN4. **Dismissal:** the bar has a close button; the device remembers `<id>:<revision>` in `localStorage` (`vd-announcement-dismissed`, behind try/catch) and hides that bar. Editing the text, link or tone increments `revision`, so the edited bar shows again; a change of the schedule alone does not. Without storage the bar can be closed for the page view only. A dismissed bar must not flash on load (for example: a constant inline script in the layout, as the theme script, ADR 0015, sets a root attribute from storage that the bar's CSS reads).

### Publishing to the store
- CP1. Every admin content change that succeeds (pages, FAQ, banners, announcements, settings) queues `store.revalidate` through the existing interceptor (S09 SF4, at most one per 10 seconds). The store's internal route expires the `catalog` and the new `content` tag.
- CP2. The store reads content through public API routes in `'use cache'` functions tagged `content` with a life of 60 seconds (stale 60, revalidate 60). A schedule boundary (BN4, AN1) therefore shows on the store within about 2 minutes, without a job. A failed read is never cached: a missing announcement, banner set or activity card must not break the page that shows it (as the footer's Telegram link, S12 SC2); `/faq` and the pages show the route's error view with a retry.
- CP3. The public routes answer `Cache-Control: public, max-age=60` and carry nothing but what the store shows: never drafts, archived rows, admin ids or unpublished pages.

### Live activity
- LA1. Built from real orders only (owner, 2026-10-11): `status = 'delivered'`, `not is_test`, `delivered_at` at least 5 minutes ago and within the last 24 hours, product unarchived and game shown (S09 SF1). Partly refunded, refunded and every other status never appear.
- LA2. Each item: the game's Arabic name, the product's Arabic name, the quantity when above 1 ("× 2"), the delivery duration `delivered_at − paid_at` (S08 T1), and the rounded time (LA4); it links to the game page. Nothing else: no customer, player ID, nickname, order number, price, supplier, code, city or country.
- LA3. **Minimum:** the home feed shows only while at least 5 qualifying deliveries (LA1) exist store-wide; a game page's feed only while that game has at least 5. Below it, the section is not rendered at all (no "no activity" text, no fake rows; scope §3 principle 3).
- LA4. The time shown is `delivered_at` floored to 5 minutes by the API (`floorToFiveMinutes`); the store shows "منذ نحو N دقيقة" (N a multiple of 5, at least 5) under an hour and "منذ نحو N ساعة" after. The exact time never leaves the API.
- LA5. The duration reads "خلال 14 ثانية" under a minute, "خلال 3 دقائق" under an hour, "خلال ساعتين" after (`formatDeliveryDuration`, Arabic plural forms through i18n).
- LA6. The switch `live_activity_enabled` (on by default, owner 2026-10-11) turns the feed off on every page; the public route then answers no items. Changing it is audited and refreshes the store (CP1).
- LA7. **Removed from the store (owner, 2026-10-19: the store no longer shows live activity; the API route, the panel switch and its preview stay, so it can return later).** Placement as built: on the home page, a card "آخر التسليمات" under the service status line (S09 SS2) with the first 3 items and the other 7 in a native `<details>` ("عرض المزيد"); on the game page, the same card with that game's items under the packs. Rendered on the server, no client JavaScript.

### Terms acceptance
- TA1. On `/sign-up`, under the submit button: "بإنشائك حساباً توافق على الشروط والأحكام وسياسة الخصوصية", each name a link to its page, only for the pages that are published; with neither published, no sentence (owner, 2026-10-11). No checkbox.
- TA2. When the customer row is created, the API stores the newest published `terms` and `privacy` versions as `terms_version_id` and `privacy_version_id` (null for an unpublished page), read in the same transaction. A later version asks nothing of existing customers.
- TA3. The admin customer profile (S12) shows "الشروط: النسخة N (<date>)" and the same for privacy, or "قبل نشر الشروط".

### Store layout additions
- SL1. Footer: "الأسئلة الشائعة", "الشروط والأحكام", "سياسة الخصوصية", "سياسة الاسترداد", "من نحن", each only once published, beside "الدعم" and the Telegram link, from the cached site content under `<Suspense>`.
- SL2. Home page: when at least one banner is `live`, a carousel of the live banners sits under the hero (the hero stays): CSS scroll-snap with dots, auto-advancing every 3 seconds by a small client part (owner, 2026-10-19: the current banner centred with its neighbours peeking on both sides, dimmed, in an endless loop; previous and next arrows from `sm`; the current dot fills over the 3 seconds), paused while hovered, focused or touched and never under `prefers-reduced-motion`; the first image loads eagerly with `fetchpriority="high"`, the others lazily, with `srcset` (S09 SF5) and the alt text. A banner with a link is one link.
- SL3. `/support` and `/support/new`: a callout "قبل أن تكتب لنا: اقرأ الأسئلة الشائعة" linking to `/faq`, while the FAQ is published.
- SL4. Sitemap: `/faq` and each published page, beside the S09 entries.
- SL5. Performance budgets (`e2e/store.spec.ts`) stay: the home page at most 210 KB of JS. If the carousel's client part cannot fit, the PR may raise the home budget to at most 215 KB with the measured figure and the reason (store `CLAUDE.md`). The game page and the share page budgets are unchanged; the content pages and `/faq` get a budget of 215 KB (server-rendered, no client part of their own).

## Money flows
None. S14 moves no money and reads only `orders` for live activity.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/content/site` | Public, `public, max-age=60` | — | `siteContentSchema`: `announcement` (`id`, `revision`, `text`, `linkPath`, `tone`) or null; `banners` (live, ≤ 5: `id`, `imageId`, `altText`, `linkPath`); `pages` (published: `page`, `title`, `updatedAt`); `faqPublished` | — |
| `GET /api/content/pages/:page` | Public, `public, max-age=60` | `page` in `CONTENT_PAGES` | `publishedPageSchema` (`page`, `title`, `body`, `version`, `updatedAt`) | `NOT_FOUND` (unpublished or unknown) |
| `GET /api/content/faq` | Public, `public, max-age=60` | — | `publishedFaqSchema` (`sections`, `updatedAt`) | `NOT_FOUND` (FQ5) |
| `GET /api/content/activity` | Public, `public, max-age=60` | `game?` (slug) | `activitySchema` (`items`: `gameSlug`, `gameNameAr`, `productNameAr`, `quantity`, `durationSeconds`, `deliveredAt` floored) | `VALIDATION_FAILED` (malformed slug); an unknown game answers no items |
| `GET /api/admin/content/pages` | Admin | — | the four pages: draft title, revision, `updatedAt`, newest version number and date, `unpublishedChanges` | — |
| `GET /api/admin/content/pages/:page` | Admin | — | `pageDraftSchema` with the versions list (number, title, date) | `NOT_FOUND` |
| `GET /api/admin/content/pages/:page/versions/:version` | Admin | — | `pageVersionSchema` | `NOT_FOUND` |
| `PUT /api/admin/content/pages/:page/draft` | Admin | `savePageDraftSchema` (`title`, `body`, `revision`) | `pageDraftSchema` | `VALIDATION_FAILED`, `CONTENT_STALE` |
| `POST /api/admin/content/pages/:page/publish` | Admin | `{ revision }` | `pageVersionSchema` | `VALIDATION_FAILED`, `CONTENT_STALE`, `CONTENT_UNCHANGED` |
| `POST /api/admin/content/pages/:page/versions/:version/restore` | Admin | `{ revision }` | `pageDraftSchema` | `NOT_FOUND`, `CONTENT_STALE` |
| `GET /api/admin/content/faq` | Admin | `archived?` | the working copy (sections with questions, archived ones when asked), `revision`, newest publication (revision, date, counts) | — |
| `POST /api/admin/content/faq/sections` · `PATCH …/sections/:id` | Admin | `faqSectionSchema` (`title`) | the section | `VALIDATION_FAILED`, `CONTENT_LIMIT_REACHED`, `NOT_FOUND` |
| `POST …/faq/sections/:id/archive` · `…/restore` | Admin | — | the section | `NOT_FOUND`, `CONTENT_LIMIT_REACHED` |
| `POST /api/admin/content/faq/items` · `PATCH …/items/:id` | Admin | `faqItemSchema` (`sectionId`, `question`, `answer`) | the question | `VALIDATION_FAILED`, `CONTENT_LIMIT_REACHED`, `PARENT_ARCHIVED`, `NOT_FOUND` |
| `POST …/faq/items/:id/archive` · `…/restore` | Admin | — | the question | `NOT_FOUND`, `CONTENT_LIMIT_REACHED`, `PARENT_ARCHIVED` |
| `PUT /api/admin/content/faq/order` | Admin | `faqOrderSchema` | the working copy | `VALIDATION_FAILED` |
| `POST /api/admin/content/faq/publish` | Admin | `{ revision }` | the publication (revision, date, counts) | `CONTENT_STALE`, `CONTENT_UNCHANGED` |
| `POST /api/admin/content/banners/image` | Admin, multipart `file` | — | `{ fileId, width, height }` | `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE` |
| `GET /api/admin/content/banners` | Admin | `archived?` | banners with `state` (BN4), ordered | — |
| `POST /api/admin/content/banners` · `PATCH …/banners/:id` | Admin | `bannerSchema` (`imageFileId`, `altText`, `linkPath?`, `startsAt?`, `endsAt?`) | the banner | `VALIDATION_FAILED`, `CONTENT_LIMIT_REACHED`, `NOT_FOUND` |
| `POST …/banners/:id/enable` · `…/disable` · `…/archive` · `…/restore` | Admin | — | the banner | `NOT_FOUND`, `CONTENT_LIMIT_REACHED` |
| `PUT /api/admin/content/banners/order` | Admin | `{ ids }` | the banners | `VALIDATION_FAILED` |
| `GET /api/admin/content/announcements` | Admin | `archived?` | announcements with `state` | — |
| `POST /api/admin/content/announcements` · `PATCH …/announcements/:id` | Admin | `announcementSchema` (`text`, `linkPath?`, `tone`, `startsAt?`, `endsAt?`) | the announcement | `VALIDATION_FAILED`, `CONTENT_LIMIT_REACHED`, `NOT_FOUND` |
| `POST …/announcements/:id/enable` · `…/disable` · `…/archive` · `…/restore` | Admin | — | the announcement (enable also names the one it disabled) | `NOT_FOUND`, `CONTENT_LIMIT_REACHED` |
| `GET` · `PUT /api/admin/content/settings` | Admin | `{ liveActivityEnabled }` | `contentSettingsSchema` | `VALIDATION_FAILED` |
| `GET /api/admin/content/activity` | Admin | — | `{ enabled, qualifyingLast24h, minimum, visible, items }`: the store-wide feed as the store would show it, ignoring the switch | — |
| `GET /api/admin/customers/:id` (S12, extended) | Admin | — | adds `termsVersion`, `privacyVersion` (number and date, or null) | — |

New error codes: `CONTENT_STALE` (a draft or the FAQ changed since it was read), `CONTENT_UNCHANGED` (nothing to publish), `CONTENT_LIMIT_REACHED` (FQ2, BN3, AN2). Arabic texts in both apps' `errors.<code>`.

The public content routes use the default public rate limit (ADR 0008); the admin routes are under `/api/admin/` with TOTP (ADR 0016). The content admin controller carries `StoreRevalidateInterceptor` (CP1).

## Jobs and integrations
- No new job. `store.revalidate` (S09) is queued by content changes (CP1); the store's internal route expires `catalog` and `content`.
- No supplier, chain, email, push or Telegram call.

## Screens

### Store (phone width first, dark default)
- **Announcement bar** (layout, every page): one line (two at most on phones) in the `info` or `warning` callout tone, the text, "التفاصيل" when linked, a 44 px close button labelled "إغلاق الإعلان". Absent when none is live, when dismissed (AN4) or when the read failed.
- **Home** (`/`): the banner carousel under the hero (SL2), absent with no live banner; the "آخر التسليمات" card under the service status line (LA7), absent below the minimum or when off. Loading: the existing storefront skeleton; the content parts stream in their own `<Suspense>` with no skeleton (they appear or not).
- **Game page** (`/games/[slug]`): the game's "آخر التسليمات" card under the packs (LA7).
- **`/faq`**: title "الأسئلة الشائعة", jump chips per section, each section a heading with its `<details>` questions, "آخر تحديث". Error: the route's error view with a retry. 404 when unpublished.
- **`/terms`, `/privacy`, `/refund`, `/about`**: the page title as `h1`, "آخر تحديث: <date>", the body through `RichText` in a readable column (max 70 characters a line), metadata title and description from the page. 404 when unpublished.
- **Footer**: the links of SL1.
- **`/support`, `/support/new`**: the FAQ callout (SL3).
- **`/sign-up`**: the agreement sentence (TA1).

### Admin (light and dark, desktop first, usable on a phone)
- **Navigation**: "المحتوى" with tabs: "الصفحات"، "الأسئلة الشائعة"، "البانرات"، "الإعلان"، "النشاط الحي".
- **`/content/pages`**: the four pages: title, state ("غير منشورة" / "منشورة، النسخة N، <date>"), "تعديلات غير منشورة" badge, "تحرير".
- **`/content/pages/$page`**: title field; body textarea (monospace off, RTL, `dir="auto"` per line) with a short syntax help ("## عنوان، **غامق**، - قائمة، [نص](/faq)") and the MD2 problems per line; a preview pane (side by side on desktop, a tab on phones) with phone and desktop widths; "حفظ المسودة" (also `Ctrl+S`), "نشر" (a confirm dialog: "ستظهر هذه النسخة في المتجر خلال ثوانٍ"); unsaved-change guard on leaving; the versions list (number, title, date) with "عرض" (read-only preview) and "استعادة إلى المسودة". States: loading skeleton, `CONTENT_STALE` dialog with "إعادة التحميل".
- **`/content/faq`**: sections as cards with their questions; add section, add question (dialog with section, question, answer with the same preview), edit, archive, restore (an "المؤرشفة" toggle), move up and down buttons plus drag to reorder; the publish bar: "تعديلات غير منشورة منذ <time>" with "معاينة" (the FAQ as the store shows it) and "نشر الأسئلة"; or "منشورة، <date>". Empty: "لا أسئلة بعد" with "إضافة قسم".
- **`/content/banners`**: rows with the thumbnail, alt text, link, schedule, state badge (BN4), enable switch, move up and down, edit, archive; "إضافة بانر" dialog: the image drop zone with the 2:1 guide and minimum size, alt text, link path, start and end (`Asia/Damascus`), a preview at phone and desktop widths. The count "N من 5 مفعّلة". Empty: "لا بانرات" with the add button.
- **`/content/announcements`**: rows with the text, tone, link, schedule, state, enable switch (confirm when another is enabled), edit, archive; the add/edit dialog with a live preview of the bar in both tones.
- **`/content/activity`**: the switch "إظهار النشاط الحي في المتجر"; "تسليمات مؤهلة في آخر 24 ساعة: N (يظهر من 5)"; the preview card exactly as the store renders it, or "لن يظهر شيء الآن: أقل من 5 تسليمات" ; a note listing what is never shown (LA2).
- **Customer profile** (S12): the accepted versions (TA3) in the account header.

## Audit and notifications
- Audit, in the transaction of the change: `content_page.draft_saved` (page, revision, title, body length; not the body), `content_page.published` (page, version, title, body length, SHA-256 of the body), `content_page.version_restored` (page, version); `faq_section.created|updated|archived|restored` (before/after title), `faq_item.created|updated|archived|restored` (section, before/after question, answer length), `faq.reordered`, `faq.published` (revision, sections and questions counted); `banner.created|updated|enabled|disabled|archived|restored` (before/after fields), `banner.reordered`; `announcement.created|updated|enabled|disabled|archived|restored` (before/after fields; enabling also writes `disabled` for the replaced one); `content_settings.set` (before/after `liveActivityEnabled`).
- Notifications: none (no customer, Telegram or email message). The daily summary is unchanged.

## Abuse and fraud
| Abuse | Control |
|---|---|
| Script or markup injection through page, FAQ or announcement text (a stolen admin session, a bug, a row written around the API) | MD1–MD2 refuse raw HTML, images and external links on save; the renderer outputs only the parser's allowed nodes (MD5); announcements are plain text rendered as text; the store CSP (ADR 0015) and `dangerouslySetInnerHTML` never used for content |
| Turning the store into a phishing page (external links in banners, announcements or pages) | Internal paths only (MD4) everywhere, checked by the schema in the API and by the database check on `link_path`; no query strings, no `//` |
| Defacement from a stolen admin session | TOTP on the admin (ADR 0016); every change audited with before/after; page versions are append-only and can be restored; banners and announcements archived, never deleted |
| Image bombs or malicious files as banners | CT10 decoder limits, re-encoding to WebP, metadata stripped; served from the files root with `X-Accel-Redirect` (S06) |
| Identifying a customer from live activity (timing, rare packs, low volume) | 5-minute delay, times floored to 5 minutes (LA4), no personal or order data (LA2), hidden below 5 deliveries in 24 hours store-wide or per game (LA3), test orders excluded; the switch turns it off (LA6) |
| Fake or inflated activity | Built only from `delivered` orders of real customers (LA1); no admin input; no fallback rows (LA3) |
| Scraping or hammering the public content routes | 60-second public caching in the store and in the route headers, the default public rate limit, nginx limits (ADR 0008); probing game slugs answers no items, revealing nothing |
| Two tabs overwriting each other's draft, or publishing something not previewed | Revision checks on save and publish (PG3, PG5, FQ6) |
| A dismissed announcement re-shown forever or a changed one hidden | `<id>:<revision>` in storage (AN4) |

## Edge cases
1. Publishing a page whose draft is empty: `VALIDATION_FAILED` (`details.body`).
2. Publishing twice in quick succession: the second sends the same revision; it is `CONTENT_UNCHANGED` (the newest version equals the draft).
3. Saving a draft while the other tab published: the save succeeds when the revision matches (publishing does not change the draft revision); the page then shows "تعديلات غير منشورة" again.
4. Restoring the newest version into the draft: allowed; the draft then equals it and publishing is `CONTENT_UNCHANGED`.
5. A sign-up in the same moment as a terms publish: TA2 reads the newest version inside the customer insert transaction; either version is a correct answer, and the one stored is the one in force at that commit.
6. Archiving the last question of a section: the section is left out of the next publication (FQ5); with no question left, publishing yields an empty FAQ and `/faq` answers 404 (and the footer link and support callout disappear).
7. Reordering FAQ with a stale list (a question added in another tab): `VALIDATION_FAILED`; the panel reloads the working copy.
8. A banner whose image is a valid `catalog_image` of a game: allowed (the API checks the kind, not the origin); the ratio is checked at upload only, so the panel only offers images from the banner upload.
9. Enabling a banner with its end in the past (an old banner): enable is allowed, its state is `ended`, it is not shown and still counts toward the 5 enabled (BN3); the panel suggests disabling ended banners.
10. A scheduled banner starting while the store has a cached `site` read: shown within about 2 minutes (CP2).
11. Enabling an announcement while another is enabled: the old one is disabled in the same transaction (AN2); two concurrent enables: the unique partial index refuses the second, which retries once inside its transaction or answers `CONTENT_STALE`.
12. Announcement text with a URL or phone number typed in: shown as plain text, not a link (AN1); allowed, since the admin writes it.
13. The S05 stop banner, the S12 frozen banner and the announcement together: all three show in that order (AN3).
14. Live activity with an order delivered by a manual fulfilment hours after payment: shown with its real duration ("خلال 3 ساعات"), since the truth is shown (scope §3).
15. Live activity when a product or game is archived or hidden after delivery: its rows drop out (LA1), and may take the feed below the minimum.
16. A partly delivered order (status `partially_refunded`): never shown (LA1).
17. Live activity switched off: the public route answers no items (the store shows no cards since 2026-10-19, LA7; the panel's preview follows the switch).
18. The API down while the store renders: the announcement, banners and activity are omitted (CP2); the pages and `/faq` show the error view; nothing fake is shown.
19. A page body with a `#` heading pasted from elsewhere: refused with its line (MD2), and the panel suggests `##`.
20. A link to an unpublished page (`/about` before publishing): allowed by MD4; the store's 404 handles it. The panel warns when a link points to one of the four pages or `/faq` while unpublished.

## Open questions
None blocking S14. Q10 (the texts of the terms, privacy, refund and about pages, and the business identity on "من نحن") stays open for the launch: S14 ships the editor and the pages unpublished; a separate session before the pilot drafts the texts from the project's rules (refunds to the wallet, no withdrawals, delivered orders final, codes shown only to the buyer, data kept) for the owner to review and publish (owner, 2026-10-11).

## Acceptance
- Owner check in the browser (dev, fake supplier, test data):
  1. Panel → المحتوى → الصفحات: all four "غير منشورة". The store footer shows no policy links; `/terms` is 404; `/sign-up` shows no agreement sentence.
  2. Edit "الشروط والأحكام": type a body with `##`, bold, a list and `[الأسئلة](/faq)`; add `<b>x</b>` and `[x](https://example.com)`: two problems shown by line, save refused. Remove them, save, preview at phone width, publish. The store shows `/terms` with "آخر تحديث", the footer link and the sign-up sentence (terms only).
  3. Sign up a new test customer: the panel customer profile shows "الشروط: النسخة 1". Publish a second version: the profile still shows version 1. Open the editor in two tabs, save in one, save in the other: "تم تعديل المسودة في مكان آخر".
  4. FAQ: add two sections and four questions, reorder, archive one; the badge says "تعديلات غير منشورة". Preview, publish: `/faq` shows the accordion, the footer link and the support callout appear. Archive every question and publish: `/faq` is 404 and the links disappear.
  5. Banners: upload a square image: refused with the 2:1 message. Upload a 1600 × 800 image, link `/games/pubg-mobile`, enable: the home page shows it within seconds; add a second scheduled 5 minutes ahead: it appears about then; carousel advances and stops on touch. Try to enable a sixth: refused.
  6. Announcement: create one in `info`, enable: every store page shows it under the header; close it: it stays closed across pages and after reload; edit its text: it shows again. Enable another: the first turns off. Turn on the purchase stop (S05): the stop banner sits above the announcement.
  7. Live activity (since 2026-10-19 the store shows no cards, LA7; checked in the panel): with fewer than 5 real deliveries, the panel's preview says why. Buy 5 orders for a real (non-test) dev customer with the fake supplier delivering, wait 5 minutes: the preview shows them with game, pack, "خلال N ثانية" and "منذ نحو 5 دقائق"; a test customer's order never appears; the home and game pages show no activity card. Turn the switch off: the preview says nothing would show.
  8. The audit log shows the draft saves, publications, FAQ changes, banner and announcement changes and the switch.
- Tests:
  - Contracts (100%): MD1–MD4 accepted and refused cases with line numbers, `parseRichText` output (and that HTML, images and external links never become nodes), `linkPathSchema` (`//`, schemes, `..`, query strings), `bannerState`, `announcementState`, `activityVisible`, `floorToFiveMinutes`, `formatDeliveryDuration`, the limits.
  - Database: append-only grants and trigger on `content_page_versions` and `faq_publications`; the one-enabled announcement index; the time and enabled-archived checks; the `link_path` check; seeds (four drafts, the settings row); the activity index; the new customer columns.
  - API: each admin route 401 without a session and 403 without TOTP; success and each error code (`CONTENT_STALE`, `CONTENT_UNCHANGED`, `CONTENT_LIMIT_REACHED`, `PARENT_ARCHIVED`, `IMAGE_INVALID` for size and ratio); publish writes the version, the audit entry and the revalidation job in one transaction; the public routes never return drafts, archived rows or unpublished pages, and answer `Cache-Control: public, max-age=60`; live activity: test orders, non-delivered statuses, orders under 5 minutes or over 24 hours, archived products and hidden games excluded; the minimum store-wide and per game; times floored; nothing but LA2 fields in the body; the switch; the sign-up stores the newest versions and null when unpublished; concurrent announcement enables leave one enabled.
  - Store unit: the relative time and duration texts, the dismissal key logic behind try/catch.
  - E2E with RTL screenshots, dark and light, phone and desktop: store home with banners, the announcement and the activity card; the home without any of them; the game page card; `/faq`; `/terms`; the footer links; the sign-up sentence; the support callout; the dismissed announcement not flashing. Admin: `/content/pages`, the page editor with problems and preview, the versions list, `/content/faq` with the publish bar, `/content/banners` with the dialog and its ratio refusal, `/content/announcements` with the replace confirm, `/content/activity` above and below the minimum. Performance budgets (SL5) measured.
- PR plan:
  1. Contracts (`content.ts`, error codes, audit types), db (tables, enums, seeds, grants, the activity index, the customer columns), the api `content` module with the public and admin routes, the sign-up versions (TA2), the S12 profile fields, the store revalidation of the `content` tag; OpenAPI and the admin client.
  2. `packages/ui` `RichText`; the admin `/content` screens and the profile line, with E2E.
  3. Store: the announcement bar, footer links, home banners and activity, the game page card, `/faq`, the four pages, the sign-up sentence, the support callout, the sitemap; E2E and the performance budgets.

## Settled in implementation
- The PR plan: the spec's PRs 2 and 3 (admin screens, then the store) ship as one PR (owner, 2026-10-11).
- PR 1 (contracts, db, api):
  - MD2's problems come back as validation issues at `path: [field, line]` with the reason as `message` (`html`, `image`, `table`, `code`, `rule`, `link`, `heading_level`, `list_depth`), the shape every other `VALIDATION_FAILED` has; `richTextSchema` reports them on save and the API the same way on publish.
  - The parser: a single new line inside a paragraph is a line break; a list item indented 2 or more spaces past its parent's marker is a child, a third level is a `list_depth` problem kept as its parent's text; `text` followed by `---` is a refused rule (no setext `##`); inline code is plain text. Headings get the ids `section-1`, `section-2`, … in order (fragments must fit MD4's `A–Z a–z 0–9 - _`, so Arabic titles cannot be ids).
  - A refused construct never becomes markup: raw HTML and tables stay text, images and code fences are dropped, a refused link keeps its text.
  - The FAQ's working copy answers `changedAt`, the newest change of a section or question, for "تعديلات غير منشورة" (the spec's "since" would need a column the data model does not have). Every FAQ change takes the `content_settings` row's lock through the revision increment, so FAQ changes are serialized; banner and announcement changes are serialized by an advisory lock each, so AN2's concurrent enables never meet the unique index (it still answers `CONTENT_STALE` if they did).
  - A customer's accepted versions are guarded by `customers_accepted_versions` (migration 0048): each is a version of its own page and never changes. Only the store's sign-up stores them; test customers created in the panel keep null.
  - Enabling an archived banner or announcement answers `VALIDATION_FAILED`: restore it first. Archiving or restoring a row already in that state answers it unchanged.
  - Audit entities without a UUID use fixed ids: the pages `…0c0001`–`…0c0004` (terms, privacy, refund, about), the FAQ `…0c0010`, the content settings `…0c0020` (all `00000000-0000-7000-8000-…`).
  - The three new error codes are in the admin catalog only: the store never receives them (as S13's admin codes).
  - The banner's minimum size is checked on the stored image (within 1600 px), which keeps the 2:1 ratio and is at least the minimum exactly when the upload is.
- PR 2 (RichText, admin screens, store):
  - `packages/ui` also holds the two presentational parts the store and the panel's previews share, so a preview is the store's own markup: `ActivityFeed` (LA7: three items, the rest in a native `<details>`, names isolated with `<bdi>` so "660 UC" keeps its order) and `AnnouncementBar` (AN1: the link stays outside the two clamped lines, so a long text never hides it). The texts come in translated.
  - LA4's "منذ نحو N" is `activityAge` in the contracts (whole 5 minutes, at least 5, under an hour; whole hours after); the plural forms are picked with `Intl.PluralRules('ar')` in the store and by i18next in the panel.
  - AN4 without a flash: the bar renders on the server, followed by a constant inline script that hides it when the stored `<id>:<revision>` matches (a root-attribute CSS rule would need the bar's key, which is API data, written into a style); only the close button is a client part, since Next loads a layout's client parts on every page.
  - FQ7's fragment is the last 8 hex digits of the id (`/faq#q-xxxxxxxx`, sections `#s-xxxxxxxx`): the first digits of a UUIDv7 are its creation time and repeat for rows made in the same minute.
  - The four pages and `/faq` are partially prerendered: the status is already 200 when the streamed part answers not found, so an unpublished page shows the not-found view with `noindex`, as the game pages have since S09.
  - SL5: the home page's first load measured 212 KB (the content strings, 1 KB, and the carousel's and the close button's client parts); the home budget is 215 KB, as SL5 allows. `/terms` and `/faq` stay within their 215 KB.
  - Schedules are entered in `datetime-local` fields read as Damascus wall-clock time (`apps/admin/src/features/content/damascus-time.ts`), whatever the viewer's zone.
  - The page editor publishes only a saved draft: "نشر" is disabled while the editor holds unsaved changes or Markdown problems, so the revision sent is the one saved and previewed (PG5).
  - E2E: a third store on port 4004 reads published content from `e2e/catalog-server.mjs` under `/content`; the default and empty stores read none, so the other specs' pages are unchanged.
