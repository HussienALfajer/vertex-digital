# Brand assets

Single source for Vertex Digital brand assets. Apps and packages reference files from here; don't keep other copies of the logo in the repository.

Visual identity rules: [identity.md](identity.md).

## Logo files

| Path | Contents | Use |
|---|---|---|
| `logo/svg/vertex-mark.svg` | Vertex mark, `fill="currentColor"` | UI: inherits text color, works in both themes |
| `logo/svg/vertex-mark-{green,gold,white}.svg` | Fixed-color variants | Emails, receipts, anywhere CSS color is unavailable |
| `logo/svg/vertex-logo.svg` | Full logo: the mark over the VERTEX wordmark, `fill="currentColor"` | UI (`VertexLogo` in `packages/ui`): sign-in screens, large brand moments |
| `logo/svg/vertex-logo-{green,gold,white}.svg` | Fixed-color variants of the full logo | Emails, receipts, documents |
| `logo/svg/favicon.svg` | Sand mark on a green rounded square | Browser favicon |
| `apps/store/src/app/favicon.ico` | `favicon.svg` rendered at 16, 32 and 48 px (PNG frames in one ICO) | The store's `/favicon.ico` (2026-10-14): browsers ask for it on their own, and a 404 there repeated until the server's `nginx-4xx-flood` jail banned the visitor. The App Router serves it only from `src/app/`, so it is the one derived copy outside `brand/`: re-render it when `favicon.svg` changes |
| `logo/png/vertex-mark-{green,gold,white}.png` | 512 px, transparent | Email clients and tools without SVG |
| `logo/png/vertex-logo-{green,gold,white}.png` | 1024 px wide, transparent | Email clients and tools without SVG; `vertex-logo-gold.png` is the customer emails' header, sent inside each email (`apps/worker/src/jobs/email/email-templates.ts`) |
| `logo/png/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Sand mark on Vertex Green | PWA manifest and home-screen icons (`icon-192.png` re-rendered from `icon-512.png` at exactly 192 × 192 in S15: the manifest names its size) |
| `logo/png/icon-maskable-512.png` | Sand mark on full-bleed Vertex Green, the mark inside the central 80% safe zone | The manifest's maskable icon (S15 PW1): Android crops it to its own shape |
| `logo/png/badge-96.png` | White mark, transparent | The monochrome badge of a push notification (S15 SW6): Android shows only its alpha |

The mark files were copied from Vertex Hub (traced from the Vertex Media logo). The word MEDIA cut into the mark's left stroke was replaced with DIGITAL (owner, 2026-10-06): D, I and A keep the traced outlines, G, T and L are Montserrat Medium at the same cap height, and the letters span the same length as MEDIA with even spacing; the PNGs were re-rendered from the SVGs. The full logo (final, Q16 resolved 2026-10-15) stacks the DIGITAL mark over the VERTEX wordmark traced from the Vertex Media logo, exactly as the Vertex Media logo stacks the MEDIA mark over it, so the logo reads VERTEX DIGITAL; its PNGs were rendered from the SVGs. If it is ever redrawn, keep the same file names: `packages/ui/src/brand/logo-shapes.ts` follows (its test compares them).

## Fonts

- Madani Arabic is a commercial font: its files are **never committed** (this repository is public). Keep them in `brand/fonts/private/` (git-ignored) locally and provision them on the server outside the repository.
- Expected files (WOFF2): `MadaniArabic-Regular.woff2` (400), `MadaniArabic-Medium.woff2` (500), `MadaniArabic-Bold.woff2` (700). Without them, Arabic falls back to Noto Kufi Arabic.
- Montserrat and Noto Kufi Arabic (SIL OFL) come from `@fontsource` packages in `packages/ui`.
