# Vertex Digital — Visual Identity

The single reference for how the store and the admin panel look (ADR 0012). Colors, scales and contrast values are the Vertex family's, unchanged from Vertex Hub; sections 5–9 are specific to Vertex Digital. Design tokens in `packages/ui` implement these values; if they disagree, this file wins until it is changed deliberately.

## 1. What the mark says

| Mark trait | Meaning | How the product uses it |
|---|---|---|
| A peak built from three parallel strokes | *Vertex* = the summit | Success moments: delivery done, deposit credited |
| Strokes at a constant 60° angle, equal gaps | Order, rhythm, precision | The **60° diagonal** is the signature motif; a strict 4 px spacing grid |
| Sharp corners, flat fills, no gradients | Confident, calm, trustworthy | Small radii, flat surfaces, borders over shadows |
| Deep green + sand gold | Trust + premium | Green carries structure; sand is the rare accent and the dark theme's primary action |

## 2. Color

### Brand colors

| Name | Hex | OKLCH | Role |
|---|---|---|---|
| **Vertex Green** | `#004139` | 0.337 0.061 181.4 | Structure, navigation, primary actions (light) |
| **Vertex Sand** | `#B9A87A` | 0.735 0.065 90.1 | Accent; primary action in the dark theme |
| White | `#FFFFFF` | — | Light surfaces |

### Tonal scales

Generated in OKLCH around the brand hues; the brand colors sit at `green-800` and `gold-400`.

| Step | green | gold | neutral (green-tinted) |
|---|---|---|---|
| 50 | `#E8FCF8` | `#FCF7E7` | `#F4F8F7` |
| 100 | `#DBF3EE` | `#F3EDDA` | `#E7EFED` |
| 200 | `#C2E1DA` | `#E1D9C1` | `#D4DBD9` |
| 300 | `#A0C7BF` | `#C8BD9E` | `#B8BFBE` |
| 400 | `#77AAA1` | **`#B9A87A`** | `#99A09F` |
| 500 | `#4E8E83` | `#907F4F` | `#7B8280` |
| 600 | `#307369` | `#766434` | `#616866` |
| 700 | `#235B52` | `#5D4E27` | `#4B5150` |
| 800 | **`#004139`** | `#433819` | `#353B39` |
| 900 | `#0B2D28` | `#2E260E` | `#222827` |
| 950 | `#031B17` | `#1B1505` | `#121716` |

### Status colors

Kept visibly distinct from the brand: success is a brighter emerald (not Vertex Green), warning is orange-amber (not Vertex Sand).

| Step | success | warning | danger | info |
|---|---|---|---|---|
| 50 | `#E5FFE9` | `#FFF5EE` | `#FFF4F2` | `#F0F8FF` |
| 100 | `#D4F8DA` | `#FEE8D8` | `#FEE7E3` | `#DEEFFE` |
| 500 | `#3C9555` | `#BB6814` | `#D54A43` | `#3786C3` |
| 600 | `#167A3A` | `#97520A` | `#B62926` | `#116BA7` |
| 700 | `#09602B` | `#783F04` | `#921B1A` | `#055485` |

### Semantic roles

| Role | Dark theme (store default) | Light theme |
|---|---|---|
| App background | green-950 `#031B17` | neutral-50 `#F4F8F7` |
| Surface (cards, panels) | green-900 `#0B2D28` | white |
| Raised surface (buy box, dialogs) | green-800 `#004139` | white with border |
| Text | neutral-100 `#E7EFED` | neutral-900 `#222827` |
| Muted text | neutral-300 `#B8BFBE` | neutral-600 `#616866` |
| Border | green-700 `#235B52` | neutral-200 `#D4DBD9` |
| Primary action | gold-400 bg, green-950 text | green-800 bg, white text |
| Accent | gold-400 | gold-400 (never as text) |
| Accent as text | gold-300 `#C8BD9E` | gold-700 `#5D4E27` |
| Focus ring | gold-400, 2 px, 2 px offset | gold-500 `#907F4F` |

### Measured contrast (WCAG 2.2)

| Pair | Ratio | Verdict |
|---|---|---|
| White on Vertex Green | 11.57 | AAA |
| Vertex Sand on Vertex Green | 4.93 | AA text |
| green-950 on Vertex Sand | 7.63 | AAA |
| neutral-900 on white | 14.99 | AAA |
| neutral-600 on white | 5.71 | AA |
| gold-700 on white | 8.13 | AAA |
| neutral-100 on green-950 | 15.32 | AAA |
| neutral-300 on green-900 (dark muted) | 7.90 | AAA |
| neutral-300 on green-800 | 6.19 | AA |
| gold-400 on green-900 (dark accent) | 6.30 | AA |
| gold-500 focus ring on neutral-50 | 3.68 | AA non-text (≥ 3) |
| **Vertex Sand on white** | **2.35** | **Fails — never use for text or icons on light surfaces** |

### Proportion

About 60% deep surfaces, 30% green structure, 10% sand. Sand is precious: if everything is gold, nothing is. Per-game accents (§6) take a share of the 10%, never more.

### Order and money status colors

| State | Color |
|---|---|
| Awaiting balance | warning |
| Paid, sent to supplier (in progress) | info |
| Delivered | success |
| Needs review | warning (staff only; customers see "in progress") |
| Refunded | neutral, with the refund amount in success |
| Cancelled | neutral |
| Deposit pending review | info · credited: success · rejected: danger |

## 3. Typography

| Script | Typeface | Source and license |
|---|---|---|
| Arabic | **Madani Arabic** (Namela) | Commercial. Needs a web license covering a public store (open question Q2). Files are private: never committed. |
| Latin and digits | **Montserrat** | SIL OFL |
| Arabic fallback | Noto Kufi Arabic | SIL OFL. Used until the Madani files and license are in place, and as a runtime fallback. |

- Madani's `@font-face` uses an Arabic `unicode-range`, so Latin letters and digits render in Montserrat.
- Stack: `"Madani Arabic", "Montserrat", "Noto Kufi Arabic", system-ui, sans-serif`.
- Weights: 400 body, 500 labels, 700 headings and prices. Subset and preload only what the first page needs (ADR 0008).
- Never letter-space Arabic, never italicize Arabic, never justify Arabic UI text.
- Tabular figures in prices, balances, tables and counters. Latin digits everywhere (`ar-u-nu-latn`).

Scale (size / line height, px):

| Token | Size | Line height | Use |
|---|---|---|---|
| xs | 12 | 18 | Captions, meta |
| sm | 13 | 20 | Secondary text, table cells |
| base | 15 | 24 | Body, inputs |
| md | 16 | 26 | Emphasized body; store inputs on phones (no zoom on focus) |
| lg | 18 | 28 | Section titles |
| xl | 20 | 30 | Card titles, pack amounts |
| 2xl | 24 | 34 | Page titles, prices in the buy box |
| 3xl | 30 | 40 | Wallet balance |
| 4xl | 36 | 46 | Hero |

## 4. Shape, space and depth

- **Spacing:** 4 px grid (4, 8, 12, 16, 20, 24, 32, 40, 48, 64).
- **Radius:** sm 4 (badges), md 6 (buttons, inputs), lg 8 (cards, pack tiles), xl 12 (dialogs, sheets, buy box). No pill-shaped buttons; full rounding only for avatars and status dots.
- **Depth:** borders define structure. On dark surfaces, elevation is a lighter green step, not a shadow. Shadows only for floating layers.
- **Touch:** targets at least 44 px on the store; the primary action sits within thumb reach at phone width.

## 5. The signature motif: the 60° ascent

- A short sand diagonal bar at the start of page titles.
- Parallel 60° hairlines as a quiet pattern behind the home hero, empty states and the receipt card.
- **Slide-to-pay** track drawn with 60° strokes that fill as the thumb moves; the mark completes on success.
- The order timeline's progress segments are 60° parallelograms climbing toward "delivered".
- Never animate it continuously, never use it as a full-page background behind content.

## 6. Store-specific guidance

- **Dark is the default** on the store; the light theme is a switch away and remembered. The admin panel follows the system setting.
- **Per-game accent:** every game has one accent color (from its artwork) stored with the game. It may tint: a flat band in the game page hero, the game's card border on hover, its chips and the selected pack's outline. It never colors primary buttons, prices, status or text below AA contrast; it is checked against green-900 and white when saved.
- **Game artwork** sits inside cards with the brand frame (1 px border, lg radius); never full-bleed behind text.
- **Prices:** USD first, large, tabular; the SYP equivalent next to it, muted, with "≈" only where the rate is not locked. Savings vs the official price as a small success-tinted badge.
- **Truth signals** (measured delivery time, service status, review ETA, live activity) use quiet, consistent chips with an icon and a time; never blinking or alarmist.
- **Success moments** (delivered, deposit credited): one short Motion sequence with the mark's three strokes; respects `prefers-reduced-motion`.
- **Phone first:** design every store screen at 360 px wide first; tables become cards; the buy box becomes a bottom sheet.

## 7. Iconography and motion

- Lucide icons, 1.75 px stroke, 20 px default, 16 px in dense tables. Directional icons mirror in RTL. Game and payment logos only as provided images, never redrawn.
- Motion (the library): 150 ms (hover, press), 200 ms (menus), 250 ms (dialogs, sheets), ease-out; spring only for slide-to-pay release. Respect `prefers-reduced-motion`.

## 8. Logo usage

| Rule | Value |
|---|---|
| Mark | The Vertex mark, `brand/logo/svg/vertex-mark*.svg` |
| Wordmark | VERTEX DIGITAL, drawn in the style of the Vertex Media wordmark (Phase 0, open question Q16) |
| Clear space | One stroke width of the mark on every side |
| Minimum size | Mark 24 px; below that use the favicon |
| Colorways | Sand mark on deep green (store default), green on white, white on green |
| Don't | Recolor outside the palette, stretch, rotate, outline, add shadows or gradients, place on busy game art |

## 9. Patterns to avoid

Neon gaming templates · purple/blue gradients · glassmorphism · pill-shaped buttons · fake countdowns or fake "only 2 left" urgency · fake activity or fake reviews · blinking badges · emoji as icons · heavy drop shadows · sand text on light surfaces · letter-spaced Arabic · auto-playing sound or video.

## 10. Voice (UI copy)

Modern Standard Arabic, clear and short; friendly, never slangy. Verbs on buttons ("اشحن الآن", "أودِع", "انسخ"). No exclamation marks in system messages. Every error says what to do next.

- **Gender-neutral** phrasing: address the customer with neutral constructions; describe staff actions with the passive or a noun.
- **Dates** with month names as read in Damascus (أيلول، تشرين الأول), Latin digits: "6 تشرين الأول 2026، 9:40 م".
- **Counts** agree with their number (`_one`, `_two`, `_few`, `_many`, `_other`).
- **Tanween** after the alif: "أولًا".

Glossary: one term per concept.

| Concept | Term | Not |
|---|---|---|
| Wallet | المحفظة | الحساب |
| Deposit | إيداع | شحن الرصيد |
| Top-up (a purchase) | شحن | تعبئة |
| Pack | باقة | حزمة |
| Player ID | معرّف اللاعب (ID) | رقم الحساب |
| Order | طلب | عملية |
| Delivered | تم التسليم | تم الشحن |
| Refunded to wallet | أُعيد المبلغ إلى المحفظة | تم الاسترجاع |
| Reference code | رمز المرجع | كود |

## 11. Components

Copied from the Vertex Hub design system into `packages/ui` and adapted (ADR 0012): alert-dialog, autocomplete, avatar, badge, button, callout, card, checkbox, collapsible, dialog, dropdown-menu, empty-state, field, icon-tile, input, meter, otp-field, page-header, pagination, password-input, popover, progress, select, sheet, skeleton, switch, table, tabs, textarea, toast, toggle-group, tooltip.

New for Vertex Digital: game-card, pack-tile and pack-picker, price (USD + SYP), player-id-field (live validation states), slide-to-pay, order-timeline, wallet-card, ledger-timeline, deposit-stepper, qr-code, copy-field, receipt-dropzone (paste and upload), countdown (rate lock), service-status chip, delivery-time chip, command-palette (`Ctrl+K`), gift-card and receipt-card (shareable), activity-ticker, motif (60° marks).
