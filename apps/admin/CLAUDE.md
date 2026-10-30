# apps/admin

The admin panel at `digital-admin.vertexmedia.pro`: React 19 + Vite SPA, TanStack Router / Query / Table, i18next, Arabic RTL, system theme with a remembered switch. One admin with full access and TOTP (ADR 0016): no permission checks in the UI; the API enforces access. Conventions: ADR 0002, 0011, 0012; read `brand/identity.md` before visual work.

## Layout
- `src/routes/`: thin TanStack Router file routes (guard, then a page component). `_app.tsx` guards the shell (session, then the CLI password changed, then TOTP enrolled: `setupStep()`) and holds the re-authentication provider; `login`, `change-password`, `setup-two-factor` sit outside it. `routeTree.gen.ts` is generated: never edit.
- Route files are eager (only the component is split off): anything else they import (search parsers, tab lists) lives in a light module like `<module>-search.ts`, never a page module, or the page and its dialogs land in the entry (`vite.config.ts` bundles all static entry imports into one `app` chunk).
- `src/features/<module>/`: one folder per API module, with `<module>.queries.ts` (query options and mutations), pages, dialogs, forms. `features/account/` holds sign-in, TOTP and backup codes, enrolment, password change and the re-authentication dialog (`reauthentication.tsx`).
- `src/components/`: app-wide pieces (shell, auth layout, theme switch, `form-alert.tsx`, confirm dialog, copy button, `read-failure.tsx`, `page-error.tsx` = the router's `defaultErrorComponent`, with retry and a full reload for a chunk of an earlier release). The shell sets `document.title` from the page's navigation item (`navLabelOf`).
- `src/lib/`: `api/client.ts` (`api`, `call()`, `ApiError`, `BACKGROUND_REQUEST`), `auth.ts` (`authClient`, `sessionQuery`, `useSession()`, `setupStep()`, `leaveSession()`), `session-events.ts` (handled in `main.tsx`), `admin-stream.ts`, `idempotency.ts`, `errors.ts`, `format.ts`, `report-error.ts`, `altcha.ts`, `safe-redirect.ts`, `theme.ts`, `clipboard.ts`.
- `src/i18n/locales/ar.json`: every UI string.

## Patterns to copy
- Form: `features/account/login-page.tsx` (React Hook Form + contract schema + `standardSchemaResolver`; errors via `errorMessage()` and `FormAlert`; a server error on a field is set with `type: 'server'`).
- Money action: `features/wallet/adjust-dialog.tsx` (Idempotency-Key, typed amount confirmation, refusals under their field).
- Money action built in steps (customer search, pack picker, live account check, summary, re-auth, page-level key, presets from the URL): `features/orders/new-order-page.tsx`.
- Choosing a game (live search, arrow keys and Enter, most sold, category grid): `features/catalog/game-picker.tsx`. Server-filtered table with chips and their counts, sort and every filter in the URL, sticky header and group rows, `/` to search: `features/pricing/matrix-page.tsx`.
- List with URL filters (`validateSearch`), cursor list with "load more", detail sheet: `features/audit/`. Paged list with tabs and filters in the URL, detail page with a decision panel (one dialog per decision): `features/orders/`.
- Review page with a decision form: `features/deposits/`. Decision list with a bulk action and a result per row: `features/pricing/reviews-page.tsx`.
- Waiting on something outside the panel (background polling, single-use link, QR, countdown): `features/telegram/`.
- Catalog-style editor (tabs in the URL, add/edit dialogs, move up/down, archive filters, image uploads): `features/catalog/`.
- Rows selected across pages into an all-or-nothing dialog with refused rows shown in place; a drawer editing a row's children; a tree read level by level with search in the URL; server drafts sent all or nothing: `features/suppliers/` (`offers-tab.tsx`, `import-dialog.tsx`, `routes-drawer.tsx`, `catalog-tab.tsx`, `import-category-sheet.tsx`).
- Live screen over the admin stream: `features/orders/live-page.tsx` with `lib/admin-stream.ts` (one `EventSource` per tab, `useAdminStream`, `useStreamState`; its reads are background requests). Home page of cards from one read: `features/dashboard/`.
- Search page and a profile whose tabs read their own routes: `features/customers/`. Queue and conversation with images: `features/support/`.
- Money moves with per-place precision and a job status polled: `features/reconciliation/`. Report tables with client sort, totals row and `.xlsx` download (read as a blob), Damascus periods in the URL: `features/reports/`.
- Store content editor (route tabs, preview, Ctrl+S, stale-revision dialog, `useBlocker` on unsaved changes): `features/content/`.

## Rules
- UI from `@vertex-digital/ui` only; a missing component goes into `packages/ui`. Logical CSS only (`packages/ui/src/conventions.test.ts` checks this folder). Buttons are 44 px under a coarse pointer (`buttonVariants`).
- A dialog or sheet ignores Escape and outside clicks once something was typed in it; only its own buttons close it. Row buttons sit in a `<fieldset aria-label={row name}>`. Icon-only buttons get an `aria-label` and a `Tooltip` with the same text. LTR value fields (email, password, codes) set `dir="ltr"`.
- No hard-coded user-facing text: `t('<area>.<key>')`, keys type-checked. Server errors show their code's text through `errorMessage()` (`errors.api`, `errors.auth`), never the server's message.
- Latin digits: dates and times through `lib/format.ts` (`ar-SY-u-nu-latn`); money through the contracts' `formatUsd`, typed dollars parsed with `parseUsd` into USD units, never floats. Wrap `$25.00` or `+5%` in `ltr()` inside an Arabic sentence.
- Server state in TanStack Query; query keys start with the module name. Queries never refetch on their own (focus, reconnect, set in `main.tsx`): only admin actions count toward the 30-minute idle timeout; any polling sends `BACKGROUND_REQUEST` (`X-Background-Request: 1`). Navigation badges read their own count endpoints.
- Every admin mutation runs through `useReauthentication()` in its `<module>.queries.ts`, so a route the API marks sensitive opens the re-authentication dialog and is retried; outside the shell (forced password change) it runs the action directly.
- Money dialogs: an `Idempotency-Key` per attempt from `useIdempotentRequest()`, kept across re-authentication and retries, kept after an attempt with no answer or a server fault, renewed only when a field changed after a clear refusal. Large amounts need the typed confirmation.
- API calls only through `api` / `call()`, typed by `src/lib/api/schema.gen.ts`, generated from `apps/api/openapi.json` with `--default-non-nullable=false` (a field with a default is optional in a request): never edit it, no `as never` on a body. Admin auth through `authClient` (`/api/admin/auth`).
- After an API change: `pnpm --filter @vertex-digital/api openapi:export`, then `pnpm --filter @vertex-digital/admin api:generate` (CI fails when either is stale).
- Forms validate with the `@vertex-digital/contracts` schema the API uses.
- A refused submit focuses the first refused field: `ref` from `useFocusInvalid()` (`@vertex-digital/ui`) on the `<form>`, `handleSubmit(onValid, () => focusInvalid())`, `focusInvalid()` in hand-rolled forms and after a server refusal sets a field, `focusInvalid(() => setTab(…))` when the field sits in another tab.
- A control outside a `Field` marks itself `aria-invalid` (upload button, checkbox) or its container `data-invalid` (fieldset of choices, a step). `InvalidAlert` (`components/form-alert.tsx`) sits beside the submit button while fields are refused, unless the only field is right above it.
- The panel's host serves only `/api/admin/*`, the ALTCHA challenge and `/api/catalog/images/*` (nginx): never call a customer route. Supplier thumbnails only through the API's image route.
- CSP: image previews are `data:` URLs, never `blob:`. The inline theme script in `index.html` has its hash in `deploy/nginx/vertexdigital-admin-csp.conf`; `src/csp.test.ts` fails until both match.
- Customer-written text (tickets) renders as plain text; links are never made clickable. Revealed secret values (order codes) hide again after 30 seconds.
- Crashes go to Sentry through `lib/report-error.ts` (`POST /api/admin/client-errors`, path without its query); no browser Sentry SDK. Store schedules are Damascus time (`features/content/damascus-time.ts`).

## Tests
- Unit: `src/**/*.test.ts` (Vitest) next to the code.
- E2E (`e2e/`): Playwright against the production build (`vite preview`, port 4173).
- Specs import `test` from `e2e/test.ts`, which mocks Better Auth and the API as a state machine (`admin`), with per-area mocks in `e2e/*-mock.ts` built on the contracts' pure rules. A request the mock does not answer or `openapi.json` does not declare fails the test, as do page and console errors.
- Every new or changed screen adds RTL screenshots in light and dark (`screenshot()` from `e2e/test.ts`, looping over `colorScheme`). Pick Base UI select options with `chooseOption()`.
- A race gets a proper wait (`expect(...).toPass`, a visible state), never a larger timeout; a test touring many screens may set `test.setTimeout(90_000)`.

Run from the repo root, paths from the root: `pnpm verify apps/admin/src/lib/format.test.ts` · `pnpm verify apps/admin/e2e/orders.spec.ts --grep "<title>"` (builds first). Never run the whole E2E suite here; CI runs it. Dev: `pnpm dev`, then `http://127.0.0.1:5173`, the `ADMIN_URL` the API accepts (not `localhost`; API on 3000).
