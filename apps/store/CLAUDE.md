# apps/store

The customer site at `digital.vertexmedia.pro`: Next.js 16 (App Router, Turbopack, Cache Components), Arabic RTL, dark by default (ADR 0002, 0011, 0012). Read `brand/identity.md` (§6 store guidance, §10 copy) before visual work.

## Layout
- `src/app/`: routes, thin (data loading and layout only). `layout.tsx` sets `lang="ar" dir="rtl"`, the `dark` class, the inline head scripts, header and footer. `globals.css` = Tailwind + `@vertex-digital/ui/styles.css`.
- `src/app/%5Finternal/revalidate/route.ts` is `POST /_internal/revalidate` (a folder starting with `_` is private in the App Router, so it is written `%5F`); the worker's `store.revalidate` job calls it.
- `src/components/bottom-nav.tsx` is the phone's bar (S24 NH4), `page-back-link.tsx` the store's `BackLink`: a fixed parent per route, never `history.back()` (the table in S24 NH6). At phone width the header's search and cart live in the bar; the search button stays mounted, it holds the dialog.
- Merchant routes: `app/merchant/(area)/` (layout with `MerchantNav`) and `app/merchant/(print)/` (print pages without that frame).
- Route handlers that must keep `no-cache` (`sw.js/route.ts`, `offline/route.ts`, `q/[code]/route.ts`) read per request.
- `src/features/<area>/`: one area's components, server data functions and request functions. `src/components/`: app-wide pieces (header, footer, banners, account menu, `FormAlert`, `InvalidAlert` in its own file so pages showing only a `FormAlert` don't ship it).
- `src/lib/`: `api.ts` (`apiRequest`), `idempotency.ts`, `session.ts`, `i18n.ts` (`t()`), `errors.ts` (`errorText`), `format.ts` (`ltr()`), `server-clock.ts`, `server-env.ts`, `cache-tags.ts`, `altcha.ts`, `safe-redirect.ts`, `use-search-param.ts`.
- `src/messages/ar.json`: the main catalog, shipped on every page. Some areas keep their own `messages.ar.json` read through their `i18n.ts` (`tm`, `tq`, `to`, `tp`, `th`, `ta`) so the shared catalog stays within budget; new heavy-string areas follow that.
- `src/instrumentation.ts` copies only `API_INTERNAL_URL`, `STORE_URL`, `STORE_REVALIDATE_SECRET`, `SENTRY_DSN` (and `DATABASE_URL` outside production) from the root `.env`: the public store never holds other apps' secrets. Production refuses to start without the secret or `STORE_URL`. Server errors go to Sentry via `lib/report-error.ts` (no SDK, path without query).

## Patterns to copy
- Request functions + forms: `src/features/auth/` (`requests.ts` pure with a unit test, client forms, field messages in `validation.ts`).
- Browser-read customer page (skeleton, error, sign-in redirect): `src/features/account/`. Cursor list with "load more": `src/features/wallet/`.
- Cached public reads: `src/features/catalog/data.ts` (a category's page reads the cached storefront). Money form (Idempotency-Key, ALTCHA, image upload): `src/features/deposits/deposit-form.tsx`.
- Refused-field focus: `src/features/auth/sign-up-form.tsx`, `src/features/deposits/deposit-form.tsx`. Dynamic `[id]` page: `src/features/deposits/` (`useParams` inside `<Suspense>`, `notFound()` for another customer's record).

## Rendering and caching
- Server components by default; `'use client'` only for interaction. Public pages stay static or cached: never read cookies or the session in a public page's server component; customer-specific parts load in the browser.
- With Cache Components anything time- or request-dependent sits inside `'use cache'` or a `<Suspense>` boundary, or the build fails.
- Cached API reads: a `'use cache'` function with `cacheTag` (from `lib/cache-tags.ts`: `catalog`, `content`, `support`) and `cacheLife`, called from a server component inside `<Suspense>` after `await connection()`, so it never runs during the build.
- A failed cached read throws (never cached) and the route's error view offers a retry. Exception: `siteContent()` returns null so the parts on every page never break it. Only public routes, no cookie.
- Server reads use `API_READ_TIMEOUT_MS` and cached public reads send `CACHED_READ_HEADERS` (both `lib/server-env.ts`). Per-request public reads (share, verify, quick-link pages) forward the visitor's `X-Forwarded-For` so the API's per-address limit counts the visitor.
- Read query parameters with `useSearchParam` (after hydration), not `useSearchParams`, so pages stay static without a boundary. Exception: inside a boundary the route already needs (the game page's `?pack=`, `/orders?checkout=`, print pages).
- Next keeps the previous page mounted but hidden after a client navigation (React Activity): effects' cleanups run on hide, effects again on the re-show, and every state survives. Code and tests must not assume a single visible instance.
- A form that navigates on success wraps in `FreshOnShow` (`lib/shown-again.tsx`), which mounts it afresh and so re-reads its server data on a re-show; a part that must only react uses `useShownAgain()`. Never reset a busy state before the navigation completes: the idempotency key is freed by then, so a second press would pay twice.
- What must survive a re-show or a reload goes in a form draft (`lib/form-draft.ts`: session storage, never the URL, a password or a file; cleared on success and by `forgetThisBrowser`). A long form also warns before unload (`useLeaveWarning`). Reading a page from inside a form goes through `ContentDialogLink`: `target="_blank"` replaces the form in an installed app or an in-app browser.
- `error.tsx` reloads on a chunk of an earlier release (`lib/chunk-error.ts`); `global-error.tsx` is the Arabic page for root-layout errors.

## First-load budget
- Budgets (`e2e/store.spec.ts`, gzipped): `/`, content pages and `/faq` 220 KB JS; `/games/[slug]` 238; `/cart` 394; share page `/g/<token>` 220; CSS 20 KB each. Raising one needs a reason in the PR.
- Keep money formatting and the contracts' zod schemas out of first load: render prices in server components and pass them as `children` (`PackContent` into `PackButton`); load heavy client parts with `next/dynamic` when first needed (buy box, calculator, search dialog, sheets).
- `CatalogPicture` and the header are client code on every page: they import no contracts values (`features/catalog/images.ts` keeps its own copy of the widths, checked by its test), and no Base UI tooltip or popup (Floating UI is about 30 KB).
- UI only via `@vertex-digital/ui` subpaths (`@vertex-digital/ui/components/button`), never the root barrel. Missing component: add it to `packages/ui`.
- Links on every page (header, footer, banners) to account or support pages set `prefetch={false}`, or their forms, zod and ALTCHA count in every page's first load.
- Modules the header and the bottom bar import (e.g. `features/cart/cart-keys.ts`, `features/push/rules.ts`) must not import contracts.

## Money, idempotency and session
- Every money and ticket form follows `lib/idempotency.ts`: keep the key while the body is the same; keep it whatever the body after an answer that may follow a write (no answer, server fault, `IDEMPOTENCY_KEY_REUSED`) or while an attempt is in flight, until a success; new key only for a changed body after a clear refusal.
- One form: `useIdempotentRequest`. Buy box, cart, POS, bulk, support tickets: `features/purchase/attempt.ts` `sendAttempt` (key in session storage per slot), so a lost answer keeps its key across a reload or a re-opened sheet. Checkout key release: `features/cart/checkout-key.ts`.
- `apiRequest` calls same-origin `/api/...` (nginx in production, a rewrite in dev), never throws, answers a code and `details`; `FormData` goes multipart. Customer auth is Better Auth at `/api/auth`.
- Countdowns to a server-set time use `serverNow()` (`lib/server-clock.ts`), never `Date.now()`.
- No buy while a signed-in account's private prices (`features/catalog/private-prices.ts`) are unknown; the cart checks lines against them too. `useCustomer().frozen` disables the buy box, the cart's slide, the player check and the deposit wizard.
- `readSession()` shares one `get-session` request; the `vd-signed-in` / `vd-private-prices` hints (no personal data) become `data-*-hint` on `<html>` before paint via `SESSION_HINT_SCRIPT`. Hints are never an access decision.
- Every way a session ends calls `features/account/signed-out.ts` `forgetThisBrowser()` (push subscription, cart, hints).
- Token pages (share links `/g/<token>`, verification) send `noindex` and `no-referrer`. Order codes stay masked until revealed (`revealCode`).
- Browser reads keep shown data after a failed background read, and only the newest read lands (copy `features/support/` and the merchant reads).
- Account pages are static shells; customer data loads in the browser with the session cookie and is never cached. No personal data in URLs (the pending sign-up email travels in session storage, `features/auth/pending-email.ts`).
- `localStorage` and session storage are read and written behind try/catch; features degrade without storage (cart `vd-cart`: versioned, at most 10 lines).

## UI, RTL and text
- Logical CSS only (checked here by `packages/ui/src/conventions.test.ts`). Touch targets at least 44 px (`size="xl"` buttons, `h-11` inputs); inputs use `text-md` so phones don't zoom.
- Text only through `t('<area>.<key>')` (or the area's own catalog function); copy per `brand/identity.md` §10. Separator glyphs (`·`, Arabic comma, `×`) may sit in JSX. Server errors show `errors.<code>` through `errorText()`, never the server's message.
- LTR values (email, password, IDs) set `dir="ltr"`; wrap amounts in a sentence with `ltr()`.
- What a field's blur changes must not move what is under the pointer (fixed slot for the player check status), or the click that blurred it is lost.
- A refused submit focuses the first refused field: `ref` from `useFocusInvalid()` (`@vertex-digital/ui/focus-invalid`) on the `<form>` (or the fields' container), `focusInvalid()` on every refusal, client or server. Fields mark `Field invalid` / `aria-invalid` (a fieldset sets `data-invalid`).
- `InvalidAlert` sits beside the submit button while fields are refused, unless the only field is right above it.
- Dialogs and sheets ignore Escape and outside clicks once something was typed (`packages/ui` `Dialog`); `guardTyped={false}` only where typing is the point and no button closes it.
- Image previews of local files use data URLs: the CSP allows `img-src 'self' data:`, not `blob:`.
- Brand files are imported from `brand/`, never copied into `public/`; the only exception is `src/app/favicon.ico`.

## Inline scripts and service worker
- The CSP allows inline scripts so pages stay cached (ADR 0015): `dangerouslySetInnerHTML` only for constant strings written in this repo (theme, session hint, announcement dismissal, SW registration, print `@page` rules), never API or customer data; `src/inline-scripts.test.ts` lists them by name.
- The service worker (`features/pwa/service-worker.ts`) is a constant script carrying the build id, tested by running it against fakes; it is served by `app/sw.js/route.ts`.

## Tests
- Unit: `src/**/*.test.ts` (Vitest) next to the code.
- E2E (`e2e/`) runs the production build: store on 4001; server components read `e2e/catalog-server.mjs` (4002, `e2e/catalog-fixtures.json`; `e2e/catalog.ts` derives packs and the search index); 4003 reads an empty catalog (`EMPTY_STORE_URL`), 4004 published content (`CONTENT_STORE_URL`, `e2e/content-fixtures.json`); see `e2e/servers.ts`.
- In the browser the API is mocked per test via `e2e/test.ts`: `api.on('METHOD /path', status, body)`, `api.last(key)`, `api.stream(key, events, delayMs?)`. A key with a query string wins over the bare path. Defaults (wallet, quick-buy, alerts, stream, preferences, images) are in `e2e/test.ts`.
- An unmocked request, a page error or a console error fails the test.
- `e2e/pwa.spec.ts` also checks that the favicon and every icon answer 200: a flood of 404s once got the owner banned by the server's fail2ban.
- Service workers are blocked except in `e2e/pwa.spec.ts`; push flows use `e2e/push-browser.ts`. Passkeys use Chrome's virtual authenticator on `localhost` (`e2e/passkeys.spec.ts`).
- Find fields among the visible ones (`accounts.spec.ts` `field()`), since the previous page stays mounted.
- Projects `phone` (360 px) then `desktop`. Every new screen adds RTL screenshots, dark and light, in both.
- A test that tours many screens sets `test.setTimeout(90_000)`; a race gets a proper wait, never a larger timeout.

## Checks
- `pnpm verify <file>...` with paths from the repo root, e.g. `pnpm verify apps/store/src/lib/idempotency.test.ts` or `pnpm verify apps/store/e2e/purchase.spec.ts --grep "<title>"` (builds first). The whole E2E suite runs in CI.
- Dev: `pnpm dev` (store on 3001, API on 3000).
