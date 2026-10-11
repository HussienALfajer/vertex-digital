// The API's public catalog routes as the store's server components read them in E2E (S09 rule
// SF4): the browser's requests are mocked per test (e2e/test.ts), but server components fetch
// `API_INTERNAL_URL` from the store's process, which Playwright cannot intercept. Fixed answers
// from catalog-fixtures.json; under `/empty` the store has no games yet. S10: the public gift and
// receipt links from share-fixtures.json, and `/_seen` answers the `X-Forwarded-For` of the last
// share read (the visitor's address the store must pass on). S12: the support channels, with a
// Telegram link except under `/empty`. S14: the content routes answer nothing published except
// under `/content`, the store with an announcement, banners, two pages, the FAQ and live activity
// (content-fixtures.json; delivery times relative to now, floored to 5 minutes). Started by
// playwright.config.ts; the port is the first argument.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const { storefront, games } = JSON.parse(
  readFileSync(new URL('./catalog-fixtures.json', import.meta.url), 'utf8'),
);
const content = JSON.parse(
  readFileSync(new URL('./content-fixtures.json', import.meta.url), 'utf8'),
);
const shares = JSON.parse(readFileSync(new URL('./share-fixtures.json', import.meta.url), 'utf8'));
const port = Number(process.argv[2] ?? 4002);
let lastForwardedFor = null;
const TELEGRAM_URL = 'https://t.me/vertex_support_test';

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
  const page = /^\/api\/content\/pages\/([a-z]+)$/.exec(path);
  if (page && full && content.pages[page[1]]) return json(response, 200, content.pages[page[1]]);
  if (path === '/_seen') return json(response, 200, { forwardedFor: lastForwardedFor });
  const share = /^\/api\/shares\/([A-Za-z0-9_-]{22})$/.exec(path);
  if (share) {
    lastForwardedFor = request.headers['x-forwarded-for'] ?? null;
    if (shares[share[1]]) return json(response, 200, shares[share[1]]);
  }
  const game = /^\/api\/catalog\/games\/([a-z0-9-]+)$/.exec(path);
  if (game && !empty && games[game[1]]) return json(response, 200, games[game[1]]);
  return json(response, 404, { statusCode: 404, code: 'NOT_FOUND' });
}).listen(port, '127.0.0.1');
