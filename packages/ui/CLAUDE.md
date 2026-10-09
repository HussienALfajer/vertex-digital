# packages/ui

The Vertex design system, shared by the store and the admin panel: shadcn/ui patterns on Base UI, Tailwind CSS v4 tokens, RTL (ADR 0002, ADR 0012). Copied from Vertex Hub and adapted; nothing is imported across repositories. Read `brand/identity.md` before changing anything visual.

## Layout
- `src/styles/theme.css`: the only place colors and design tokens are defined (light and `.dark`). Tailwind's default palette, fonts, radii and shadows are reset, so an off-brand utility generates no CSS.
- `src/styles/fonts.css` (Montserrat and Noto Kufi Arabic from `@fontsource`), `base.css`, `index.css` (what apps import after Tailwind), `madani.css` (the licensed faces, imported by an app only when the files exist).
- `src/components/<name>.tsx`: one component family per file, exported from `src/index.ts`. Pattern to copy: `src/components/button.tsx` (Base UI primitive + `cva` variants + `cn`).
- `src/brand/`: `VertexLogo`, `VertexMark` (path data in `logo-shapes.ts`, checked against `brand/logo/svg` by `logo-shapes.test.ts`: change the SVG file first, then copy its `viewBox` and `d`), `AscentLines`, the 60° motif, and `SuccessMark` (S09: the three 60° strokes rising once, keyframes `vd-stroke-rise` in `base.css`).
- S09 store components: `slide-to-pay.tsx` (`role="slider"`, 85% release threshold, `End` and the arrows confirm; `slideConfirms` and `slideKey` tested), `command-dialog.tsx` (`CommandDialogContent`: full screen on phones, a dialog from `sm`), and `SheetContent side="bottom"` (the buy box on phones).
- Shipped as TypeScript source (`exports` point at `src/`): the store transpiles it (`transpilePackages`), Vite reads it directly. No build step.

## Rules the tests enforce (`src/conventions.test.ts`, `src/tokens.test.ts`)
- Logical directions only: no `ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`, here and in `apps/store/src` and `apps/admin/src`.
- No hex, `rgb()` or `oklch()` values outside `theme.css`.
- None of the patterns in `brand/identity.md` §9: gradients, backdrop blur, italic, letter spacing, uppercase, monospace.
- Every tonal and status color equals `identity.md`, and the measured contrast pairs hold.

## Rules to apply yourself
- Components work in both apps: no Next.js or Vite imports, no `?raw` or other loader syntax. Interactive components are client components through their Base UI primitives; the store marks the files that use them with `'use client'`.
- Build on Base UI primitives, keep their accessibility (focus rings, keyboard, ARIA), and use the `render` prop instead of wrapper elements.
- Every component sets `data-slot` (directly, or through `useRender` state as in `badge.tsx`), merges `className` with `cn`, and passes other props through.
- Variants through `cva` with semantic names (`tone`, `variant`, `size`), mapped to semantic tokens (`bg-primary`, `text-muted-foreground`), never to raw palette steps in app code.
- No user-facing text inside components: labels come in as props, so the app translates them.
- New store components from `identity.md` §11 (game-card, price, slide-to-pay, …) arrive with the feature that first uses them, in the same style.
- Fonts: Madani Arabic files are never committed (git-ignored `brand/fonts/private/`). Every build works with the Noto Kufi Arabic fallback.

Run: `pnpm --filter @vertex-digital/ui test` · `pnpm --filter @vertex-digital/ui typecheck`.
