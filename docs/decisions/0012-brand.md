# 0012 — Brand: Vertex colors, dark store, Madani Arabic

Status: Accepted · Date: 2026-10-06

## Context
Vertex Digital belongs to the Vertex family (Vertex Media, Vertex Hub). The owner wants the store to look clearly more professional and distinct than local competitors, which mostly use loud gaming templates. Customers browse at night on phones; game artwork is colorful and must not fight the brand.

## Decision
- **Colors:** exactly the Vertex Hub palette: Vertex Green `#004139`, Vertex Sand `#B9A87A`, and the green, gold, neutral and status scales as defined in `brand/identity.md`.
- **Themes:** the store defaults to **dark** (sand on deep green, the logo's own inverse) with a light theme available; the admin panel follows the system preference with a manual switch.
- **Per-game accent:** each game has an accent color used only inside that game's page hero, chips and its card highlight, always checked for contrast; it never replaces the brand's primary action color.
- **Motif:** the 60° diagonal from the logo, used sparingly (title marks, empty states, loaders, the slide-to-pay track).
- **Logo:** the existing Vertex mark (three strokes at 60°) with a **VERTEX DIGITAL** wordmark in the style of the Vertex Media logo (owner, 2026-10-06). Mark files are copied into `brand/logo/`; the wordmark is drawn in Phase 0.
- **Typography:** **Madani Arabic** for Arabic (owner, 2026-10-06), a commercial font whose files are never committed (the repository is public): kept in git-ignored `brand/fonts/private/` locally and provisioned on the server outside the repository. Montserrat (OFL) for Latin text and digits. Builds work without Madani using the Noto Kufi Arabic fallback (OFL). A web license that covers a public store is needed before launch (open question).
- **UI language:** Arabic only in V1, through an i18n catalog from day one; English names and search terms are understood (owner, 2026-10-06). Latin digits.
- **Components:** reuse the Vertex Hub design-system components that fit (copied into `packages/ui` and adapted, not imported across repositories); new store components are built in the same style. The list is in `brand/identity.md`.
- **Motion:** the Motion library, short and purposeful (state changes, delivery success), respecting `prefers-reduced-motion`.

## Consequences
- The store shares a recognizable identity with the Vertex family while the dark default and game accents give it its own character.
- Production must have the Madani files and license in place; until then the fallback renders, as in CI.
