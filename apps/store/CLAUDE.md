# apps/store

The customer site at `digital.vertexmedia.pro`: Next.js 16 (App Router, Turbopack, Cache Components), Arabic RTL, dark by default (ADR 0002, 0011, 0012). Read `brand/identity.md` (§6 is the store's own guidance) before visual work.

## Layout
- `src/app/`: routes, thin: data loading and layout. `layout.tsx` (html `lang="ar" dir="rtl"`, the `dark` class, the theme script, header and footer), `page.tsx`, the account routes (`sign-in/`, `sign-up/`, `verify-email/`, `forgot-password/`, `account/`), `not-found.tsx`, `error.tsx`, `globals.css` (Tailwind + `@vertex-digital/ui/styles.css`).
- `src/features/<area>/`: components, server data functions and actions of one area. Pattern to copy: `src/features/auth/` (`requests.ts`: pure request functions with a unit test; the client forms that use them; field messages in `validation.ts`) and `src/features/account/` (a page read in the browser with the session cookie: skeleton, error and sign-in redirect).
- `src/components/`: app-wide pieces (header, footer, theme switch, account link and menu, form alert). `src/lib/`: `i18n.ts` (`t()`), `theme.ts`, `api.ts` (`apiRequest`: same-origin calls that answer a code, never throw), `errors.ts` (`errorText`), `altcha.ts` (proof of work in the browser), `safe-redirect.ts`, `format.ts` (dates), `use-search-param.ts`.
- `src/messages/ar.json`: every UI string. `e2e/`: Playwright specs, `test.ts` (the API mock and screenshot helper).

## Rules
- Server components by default; `'use client'` only for interaction. A page must stay static or cached: never read cookies or the session in a server component of a public page; customer-specific parts load in the browser (as `AccountLink` does) until a feature's spec says otherwise.
- With Cache Components, anything time- or request-dependent sits inside `'use cache'` (tagged per entity once the catalog exists, ADR 0002) or a `<Suspense>` boundary; the build fails otherwise.
- UI from `@vertex-digital/ui` through its subpaths only (`@vertex-digital/ui/components/button`, `@vertex-digital/ui/brand/logo`), never the root barrel: the barrel puts every client component in the first load. Missing component: add it to `packages/ui`.
- Logical CSS only; `packages/ui/src/conventions.test.ts` checks this folder too. Touch targets at least 44 px (`size="xl"` buttons, `h-11` inputs); inputs use `text-md` so phones do not zoom.
- Text only through `t('<area>.<key>')`, Arabic copy per `brand/identity.md` §10 (no exclamation marks, every error says what to do next). Server errors show `errors.<code>` through `errorText()`, never the server's message. Fields for LTR values (email, password, IDs) set `dir="ltr"`.
- Account pages are static shells; everything about the customer loads in the browser with the session cookie and is never cached. No personal data in URLs: the address waiting for its code travels in session storage (`features/auth/pending-email.ts`).
- Read query parameters with `useSearchParam` (after hydration), not `useSearchParams`, so pages stay static without a Suspense boundary.
- The store's CSP allows inline scripts so pages stay cached (ADR 0015): `dangerouslySetInnerHTML` only for constant strings written in this repository (the theme script), never for data from the API or customers.
- API calls go to `/api/...` on the same origin (nginx in production, a rewrite to the API in development). Customer auth is Better Auth at `/api/auth`.
- Brand files are imported from `brand/` (`layout.tsx` icons), never copied into a `public/` folder.
- Performance budget (`e2e/store.spec.ts`): first load of `/` at most 200 KB of JS and 20 KB of CSS, gzipped. Raising it needs a reason in the PR.

## Tests
- Unit: `src/**/*.test.ts` (Vitest), next to the code.
- E2E (`e2e/`): against the production build on port 4001; the API is mocked per test with `api.on('METHOD /path', status, body)` (`api.last(key)` reads what was sent), and a request without a mock fails the test, as do page and console errors. Next.js keeps the previous page mounted but hidden after a client navigation: find fields among the visible ones (`accounts.spec.ts`, `field()`). Every new screen adds RTL screenshots, dark and light, at phone width and desktop (the `phone` and `desktop` projects).

Run: `pnpm --filter @vertex-digital/store test` · `pnpm --filter @vertex-digital/store typecheck` · `pnpm test:e2e` (builds first) · dev: `pnpm dev` (port 3001, with the API on 3000).
