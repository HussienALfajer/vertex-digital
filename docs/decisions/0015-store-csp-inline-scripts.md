# 0015 — The store's CSP allows inline scripts instead of nonces

Status: Accepted · Date: 2026-10-07 · Amends 0008

## Context
ADR 0008 asks for a nonce-based Content Security Policy on the store. Next.js streams each page's data in inline scripts, so a nonce has to be generated per request and stamped into every page. That makes every page render on every request: no static or prerendered pages, no Cache Components static shell, and no nginx `proxy_cache` for anonymous catalog pages (ADR 0002, 0008). On Syrian connections, with a shared server and no CDN, the store's speed rests on exactly that caching. Hash-based policies do not fit either: the inline scripts change with the page content.

## Decision
- The store's CSP (`deploy/nginx/vertexdigital-store-csp.conf`) allows `'unsafe-inline'` in `script-src`; every other directive stays same-origin only (`default-src`, `connect-src`, `img-src`, `font-src`, `form-action`, `base-uri 'self'`, `object-src 'none'`, `frame-ancestors 'none'`). No external script source is allowed.
- The admin panel keeps the hash-based policy of ADR 0008: its only inline script is the theme bootstrap, checked by `apps/admin/src/csp.test.ts`.
- The defence against script injection on the store is in the code: React escapes all text; `dangerouslySetInnerHTML` is used only for constant strings written in the repository (the theme script), never for data from the API or customers; user-provided rich text, if any feature needs it, is sanitized on the server and gets its own review.
- Owner decision, 2026-10-07 (PR 4 of Phase 0). Everything else in ADR 0008 is unchanged.

## Consequences
- Pages stay static or cached, and the first-load budget of the store holds.
- An HTML injection bug on the store could run script, so the rule on `dangerouslySetInnerHTML` above is checked in review (`reviewer`); a lint or test for it is welcome.
- If Next.js later supports hash- or nonce-based policies for cached pages without dynamic rendering, revisit this record.
