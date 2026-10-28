# packages/ui

The Vertex design system, shared by the store and the admin panel: shadcn/ui patterns on Base UI, Tailwind CSS v4 tokens, RTL (ADR 0002, 0012). Copied from Vertex Hub and adapted; nothing is imported across repositories. Read `brand/identity.md` before changing anything visual.

## Layout
- `src/styles/theme.css`: the only place colors and design tokens are defined (light and `.dark`). Tailwind's default palette, fonts, radii and shadows are reset, so an off-brand utility generates no CSS.
- `src/styles/theme-hex.ts` (`@vertex-digital/ui/theme-hex`): copies of the few values needed where CSS cannot reach (the store's manifest, `theme-color`, the offline page); `tokens.test.ts` checks each against `theme.css`.
- `src/styles/`: `fonts.css` (Montserrat and Noto Kufi Arabic from `@fontsource`), `base.css`, `index.css` (what apps import after Tailwind), `madani.css` (the licensed faces, imported by an app only when the files exist).
- `src/components/<name>.tsx`: one component family per file, exported from `src/index.ts`. Pattern to copy: `src/components/button.tsx` (Base UI primitive + `cva` variants + `cn`).
- `src/brand/`: logo, mark, the 60° motif and `SuccessMark`. Logo path data is in `logo-shapes.ts`, checked against `brand/logo/svg` by `logo-shapes.test.ts`: change the SVG file first, then copy its `viewBox` and `d`.
- `src/lib/focus-invalid.ts` (`@vertex-digital/ui/focus-invalid`): `useFocusInvalid()` / `focusFirstInvalid(root)` scroll to and focus the first field marked `aria-invalid="true"` or `data-invalid` (Base UI's `Field invalid` sets both), opening closed `<details>` and switching tab or step through `reveal`. Forms use it after a failed submit; the focus moves a frame after React rendered the errors, once per call, never while typing.
- `rich-text.tsx` renders only the nodes of the contracts' `parseRichText`, never raw HTML; pass the store's `next/link` as its `link` component (the default is a plain anchor).
- Shipped as TypeScript source (`exports` point at `src/`): the store transpiles it (`transpilePackages`), Vite reads it directly. No build step.

## Rules the tests enforce (`src/conventions.test.ts`, `src/tokens.test.ts`)
- Logical directions only: no `ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`, here and in `apps/store/src` and `apps/admin/src`.
- No hex, `rgb()` or `oklch()` values outside `theme.css` (and its checked copies in `theme-hex.ts`).
- None of the patterns in `brand/identity.md` §9: gradients, backdrop blur, italic, letter spacing, uppercase, monospace.
- Every tonal and status color equals `identity.md`, and the measured contrast pairs hold.

## Rules to apply yourself
- Components work in both apps: no Next.js or Vite imports, no `?raw` or other loader syntax. Interactive components are client components through their Base UI primitives; the store marks the files that use them with `'use client'`.
- Build on Base UI primitives, keep their accessibility (focus rings, keyboard, ARIA), and use the `render` prop instead of wrapper elements.
- Every component sets `data-slot` (directly, or through `useRender` state as in `badge.tsx`), merges `className` with `cn`, and passes other props through.
- Variants through `cva` with semantic names (`tone`, `variant`, `size`), mapped to semantic tokens (`bg-primary`, `text-muted-foreground`), never to raw palette steps in app code.
- No user-facing text inside components: labels come in as props, so the app translates them.
- Fonts: Madani Arabic files are never committed (git-ignored `brand/fonts/private/`). Every build works with the Noto Kufi Arabic fallback.

## Checks
`pnpm verify packages/ui/src/<file>.test.ts(x)`; after a change to classes or colors, also run `packages/ui/src/conventions.test.ts` and `packages/ui/src/tokens.test.ts`.
