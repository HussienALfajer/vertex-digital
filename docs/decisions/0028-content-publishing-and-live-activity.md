# 0028 — Content publishing, banners, the announcement bar and live activity

Status: Accepted · Date: 2026-10-11 · Amends [0015](0015-store-csp-inline-scripts.md) (a second constant inline script may hide a dismissed announcement)

## Context
F21 asks for FAQ, policy pages, home banners and an announcement bar edited in the panel, and F25 for a real, anonymized activity feed. The store is public, cached and has a CSP that allows inline scripts only for constant strings, so content must be safe to render without trusting what is stored, and must reach the cached pages quickly. Live activity must show the truth (scope §3) without exposing any customer. The owner settled the choices in the S14 interview (2026-10-11).

## Decision
- **Fixed pages:** four pages (`terms`, `privacy`, `refund`, `about`), no admin-created pages. Each has one editable draft and append-only published versions; a page is public once published and stays so; "آخر تحديث" shows the version's date. The FAQ is a working copy of sections and questions published as one append-only snapshot. Draft, preview, publish; revision checks against stale tabs; no re-authentication, every change audited.
- **Limited Markdown, internal links only:** headings `##`/`###`, emphasis, lists, quotes and links to store paths; no HTML, images, tables or external links, refused on save. One parser in `packages/contracts` produces the allowed nodes, one renderer in `packages/ui` draws them, so stored text never becomes markup. Banners and the announcement take internal paths only.
- **Banners:** one 2:1 image (at least 1200 × 600, stored as a 1600 × 800 WebP catalog image), alt text, optional link and schedule; at most 5 enabled, shown in order and rotating.
- **Announcement:** one enabled at a time, 5–140 characters of plain text, `info` or `warning`, optional link and schedule; dismissed per device until its text, link or tone changes.
- **Publishing:** content changes queue the existing `store.revalidate` job, which now expires a `content` tag beside `catalog`; the store's cached content reads live 60 seconds, so schedules take effect within about 2 minutes without a job.
- **Live activity:** the last 10 `delivered` orders of non-test customers, delivered at least 5 minutes and at most 24 hours ago, showing the game, the pack, the quantity, the measured delivery time and a time floored to 5 minutes; on the home page and per game on the game page; hidden entirely below 5 such deliveries (store-wide, or for that game); on by default, switched off from the panel. The constants are fixed in code.
- **Terms acceptance:** sign-up states that creating an account accepts the published terms and privacy policy; the customer row keeps the versions in force; new versions ask nothing of existing customers.

## Consequences
- The store gains `/faq`, `/terms`, `/privacy`, `/refund` and `/about`, footer links and a sitemap entry for each only once published; nothing is linked before the texts exist (Q10 stays open for launch).
- A stolen admin session can change what the store says but cannot add markup, external links or scripts; versions and the audit log allow restoring.
- Live activity can be empty for a long time after the pilot opens; that is intended rather than showing fewer, more identifying rows.
- Changing the activity delay, minimum or size, adding pages, external links, images in pages, or a terms checkbox needs a new ADR.
