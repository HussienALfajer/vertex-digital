# S24 — Store navigation and home page

Status: Approved (owner, in chat, 2026-10-30) · Date: 2026-10-30 · Scope: changes to `docs/product/v1-scope.md` F09's storefront · ADRs: 0002, 0011, 0012

## Summary
The home page rendered all ~352 games (903 KB of HTML) with no way to move around a phone but the header. It becomes category cards, then one short row per category, each category with a page of its own. Phones get a five-item bottom bar, and inner pages a back link with a fixed destination.

## Owner decisions (2026-10-30)
1. **Home page:** category cards with an image at the top; then one short row per category with the first ~10 games in the panel's order and an "عرض الكل" link. Each category has its own page with all of its games.
2. **Phone bottom navigation:** five items: الرئيسية، البحث، السلة، طلباتي، المحفظة. Phone only; the desktop header stays as it is.
3. **Back links on inner pages:** each points to a fixed destination by route, never `history.back()`: a visitor from a WhatsApp link must never be sent off-site.

## In scope / out of scope
- In: the rules below, an optional category image, `/categories/[slug]`.
- Out: a change to what is shown (rule SF1 stands: paused games never appear), search, the desktop header, categories inside categories.

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the storefront, a category page | Public, cached | Anyone |
| Set a category's image | Admin (`PATCH /api/admin/catalog/categories/:id`) | The admin |
| Upload the image | Admin (`POST /api/admin/catalog/images`, S06 CT10) | The admin |

## Data
- `catalog_categories.image_file_id`: uuid, nullable, references `stored_files` (a catalog image), indexed. Backward compatible. `stored_files_unreferenced_condition()` reads the foreign keys, so a category's image is never swept (A10-45).

## Rules
- **NH1** Home: the hero, banners and "اشحن مجدداً" stay. Then the category cards (a horizontal scroll on a phone, a grid from `sm`), then one section per category with a shown game: its first 10 games in panel order (a horizontal scroll with snap on a phone, a grid from `sm`) and "عرض الكل". Each section keeps `id=<slug>`.
- **NH2** A category card shows its image; with none, a collage of its first 3 covers in the brand frame; with no covers, the Vertex mark.
- **NH3** `/categories/[slug]`: title with the ascent bar, the game count, every shown game through `GameCard`. An unknown or archived slug, or a category with no shown game, is not found. In the sitemap, with metadata as SF6. Read from the cached storefront (`catalog` tag).
- **NH4** Bottom bar (phone width only): الرئيسية, البحث (the existing dialog), السلة (with the device's count), طلباتي, المحفظة. Signed out, the last two go to sign-in with `next`. The active item follows the route. It sits under sheets and dialogs, pads for `safe-area-inset-bottom`, and the page pads for it. Hidden on print pages and on paper. Without storage the cart item is hidden (CT1).
- **NH5** At phone width the header's search and cart move to the bar; the balance, bell and account menu stay, and the header fits 360 px.
- **NH6** Back links (`BackLink`, one component in `packages/ui`; 44 px target; arrow mirrored for RTL; always a link to a fixed path):

| Route | Goes to |
|---|---|
| `/wallet/deposit`, `/wallet/deposits` | `/wallet` |
| `/wallet/deposits/[id]` | `/wallet/deposits` |
| `/orders/[id]` | `/orders` |
| `/support/new` | `/support` (`/support/[id]` keeps its own) |
| `/account/*` | `/account` |
| `/games/[slug]` | its category's page (home for a game outside the storefront, S23 OP5) |
| `/categories/[slug]`, `/cart`, `/notifications`, `/faq`, the published pages, `/sign-in`, `/sign-up`, `/wallet`, `/orders`, `/support`, `/account` | home |
| `/forgot-password`, `/verify-email` | `/sign-in` |
| The merchant area | `/account` |

Not on the home page, print pages (they have one) or token pages (`/g`, `/r`, `/v`, `/m`).

## Money flows
None.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/catalog/storefront` | Public | | `storefrontSchema`, each category with `image` | |
| `PATCH /api/admin/catalog/categories/:id` | Admin | `updateCategorySchema`: `nameAr` and/or `imageFileId` (null clears) | `categorySchema` with `image` | `NOT_FOUND` for a file that is not a catalog image |

## Jobs and integrations
None new; `StoreRevalidateInterceptor` refreshes the store on the write.

## Screens
- Admin, "إدارة الفئات": an image field on each live category, through the existing `ImageUpload`.
- Store: as the rules. Every new screen has RTL screenshots, dark and light, at 360 px and desktop.

## Audit and notifications
A changed image writes `catalog_category.updated` with its before and after. No notification.

## Abuse and fraud
Only the admin sets an image, and only an existing catalog image is accepted. A category page reads the cached storefront, so a made-up slug reaches no database. No customer data in any URL: `next` holds a path.

## Edge cases
1. A category with no shown game has no card, no row and no page.
2. A category with fewer than 10 games still has "عرض الكل", its page having the count.
3. Signed-out state unknown yet: the links go to the page, which sends a signed-out visitor to sign-in itself.
4. A game in early access is not in the storefront: its back link goes home.
5. An image that fails to load falls back as every catalog image does (`CatalogPicture`).

## Open questions
None.

## Acceptance
- Home HTML at least ~70% smaller than 903 KB raw; no first-load budget raised.
- The rules above have E2E tests at both widths; `pnpm verify` passes.
