// The API's public catalog routes as the store's server components read them in E2E (S09 rule
// SF4): the browser's requests are mocked per test (e2e/test.ts), but server components fetch
// `API_INTERNAL_URL` from the store's process, which Playwright cannot intercept. Fixed answers
// from catalog-fixtures.json; under `/empty` the store has no games yet. S10: the public gift and
// receipt links from share-fixtures.json, and `/_seen?token=` answers every `X-Forwarded-For` a
// read of that share carried (the visitor's address the store must pass on; every value, not the
// last one, since tests in other workers read shares at the same time). S22: `/api/q/<code>`
// with the same record of the visitor's address and campaign. S12: the support channels, with a
// Telegram link except under `/empty`. S14: the content routes answer nothing published except
// under `/content`, the store with an announcement, banners, two pages, the FAQ and live activity
// (the store no longer shows activity since 2026-10-19: the specs check it stays hidden while the
// route answers; content-fixtures.json; delivery times relative to now, floored to 5 minutes: the newest is in
// the current 5 minutes, so it reads "منذ نحو 5 دقائق" for 5 minutes at least, while the store's
// 60-second content cache serves it; one floored from 5 minutes ago turned into "10" whenever the
// next 5-minute mark passed in between). Started by playwright.config.ts; the port is the first
// argument. Audit A03-7: `/_flaky?slug=flaky-…&fail=1` makes that game's read fail until
// `fail=0`, for the error view's retry.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const { storefront, games } = JSON.parse(
  readFileSync(new URL('./catalog-fixtures.json', import.meta.url), 'utf8'),
);
const content = JSON.parse(
  readFileSync(new URL('./content-fixtures.json', import.meta.url), 'utf8'),
);
const shares = JSON.parse(readFileSync(new URL('./share-fixtures.json', import.meta.url), 'utf8'));
// S21 VF2: the verification pages' orders, by their codes.
const verifications = JSON.parse(
  readFileSync(new URL('./verify-fixtures.json', import.meta.url), 'utf8'),
);
const port = Number(process.argv[2] ?? 4002);
/** Share token → the `X-Forwarded-For` values its reads carried. */
const forwardedFor = new Map();
const TELEGRAM_URL = 'https://t.me/vertex_support_test';
/** Audit A03-7: game slugs whose read fails until `/_flaky?slug=&fail=0`; PUBG's data otherwise. */
const failing = new Set();

const NO_CONTENT = { announcement: null, banners: [], pages: [], faqPublished: false };
const FIVE_MINUTES = 5 * 60 * 1000;

/** S14 LA2–LA4: the feed, store-wide or one game's, below the minimum of 5 answering none. */
function activity(game) {
  const items = content.activity
    .filter((item) => !game || item.gameSlug === game)
    .map(({ minutesAgo, ...item }) => ({
      ...item,
      deliveredAt: new Date(
        Math.floor((Date.now() - minutesAgo * 60_000) / FIVE_MINUTES) * FIVE_MINUTES,
      ).toISOString(),
    }));
  return { items: items.length >= 5 ? items : [] };
}

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const empty = url.pathname.startsWith('/empty/');
  const full = url.pathname.startsWith('/content/');
  const path = empty || full ? url.pathname.slice(url.pathname.indexOf('/', 1)) : url.pathname;
  if (request.method !== 'GET') return json(response, 405, { code: 'NOT_FOUND' });
  if (path === '/health') return json(response, 200, { ok: true });
  if (path === '/api/catalog/storefront') {
    return json(response, 200, empty ? { service: 'normal', categories: [] } : storefront);
  }
  // S12 SC2: the footer and `/support` read the Telegram link; the empty store has none.
  if (path === '/api/support/channels') {
    return json(response, 200, { telegramUrl: empty ? null : TELEGRAM_URL });
  }
  if (path === '/api/content/site') return json(response, 200, full ? content.site : NO_CONTENT);
  if (path === '/api/content/activity') {
    return json(response, 200, full ? activity(url.searchParams.get('game')) : { items: [] });
  }
  if (path === '/api/content/faq' && full) return json(response, 200, content.faq);
  const page = /^\/api\/content\/pages\/([a-z_]+)$/.exec(path);
  if (page && full && content.pages[page[1]]) return json(response, 200, content.pages[page[1]]);
  if (path === '/_seen') {
    const seen = forwardedFor.get(url.searchParams.get('token')) ?? new Set();
    return json(response, 200, { forwardedFor: [...seen] });
  }
  const share = /^\/api\/shares\/([A-Za-z0-9_-]{22})$/.exec(path);
  if (share) {
    const seen = forwardedFor.get(share[1]) ?? new Set();
    seen.add(request.headers['x-forwarded-for'] ?? null);
    forwardedFor.set(share[1], seen);
    if (shares[share[1]]) return json(response, 200, shares[share[1]]);
  }
  const verification = /^\/api\/verify\/([A-Za-z0-9_-]{22})$/.exec(path);
  if (verification) {
    const seen = forwardedFor.get(verification[1]) ?? new Set();
    seen.add(request.headers['x-forwarded-for'] ?? null);
    forwardedFor.set(verification[1], seen);
    if (verifications[verification[1]]) return json(response, 200, verifications[verification[1]]);
  }
  // S22 DL2: direct buy links; `K7M2QX` is PUBG's 660 UC, `G2MEXX` a paused game's pack. The
  // visitor's address is kept per code, as for the shares.
  const quick = /^\/api\/q\/([2-9A-HJKMNP-Z]{6})$/.exec(path);
  if (quick) {
    const seen = forwardedFor.get(quick[1]) ?? new Set();
    seen.add(`${request.headers['x-forwarded-for'] ?? ''}|${url.searchParams.get('c') ?? ''}`);
    forwardedFor.set(quick[1], seen);
    const pubg = games['pubg-mobile'];
    const targets = {
      K7M2QX: {
        target: 'pack',
        gameSlug: 'pubg-mobile',
        productId: pubg.products.find((item) => item.nameAr === '660 UC').id,
      },
      G2MEXX: { target: 'home' },
    };
    if (targets[quick[1]]) return json(response, 200, targets[quick[1]]);
  }
  if (path === '/_flaky') {
    const slug = url.searchParams.get('slug') ?? '';
    if (url.searchParams.get('fail') === '1') failing.add(slug);
    else failing.delete(slug);
    return json(response, 200, { failing: [...failing] });
  }
  const flaky = /^\/api\/catalog\/games\/(flaky-[a-z0-9-]+)$/.exec(path);
  if (flaky) {
    if (failing.has(flaky[1])) return json(response, 503, { code: 'INTERNAL_ERROR' });
    const pubg = games['pubg-mobile'];
    return json(response, 200, { ...pubg, game: { ...pubg.game, slug: flaky[1] } });
  }
  const game = /^\/api\/catalog\/games\/([a-z0-9-]+)$/.exec(path);
  if (game && !empty && games[game[1]]) return json(response, 200, games[game[1]]);
  return json(response, 404, { statusCode: 404, code: 'NOT_FOUND' });
}).listen(port, '127.0.0.1');
