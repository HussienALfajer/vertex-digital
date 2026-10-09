// The API's public catalog routes as the store's server components read them in E2E (S09 rule
// SF4): the browser's requests are mocked per test (e2e/test.ts), but server components fetch
// `API_INTERNAL_URL` from the store's process, which Playwright cannot intercept. Fixed answers
// from catalog-fixtures.json; under `/empty` the store has no games yet. Started by
// playwright.config.ts; the port is the first argument.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const { storefront, games } = JSON.parse(
  readFileSync(new URL('./catalog-fixtures.json', import.meta.url), 'utf8'),
);
const port = Number(process.argv[2] ?? 4002);

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const empty = url.pathname.startsWith('/empty/');
  const path = empty ? url.pathname.slice('/empty'.length) : url.pathname;
  if (request.method !== 'GET') return json(response, 405, { code: 'NOT_FOUND' });
  if (path === '/health') return json(response, 200, { ok: true });
  if (path === '/api/catalog/storefront') {
    return json(response, 200, empty ? { service: 'normal', categories: [] } : storefront);
  }
  const game = /^\/api\/catalog\/games\/([a-z0-9-]+)$/.exec(path);
  if (game && !empty && games[game[1]]) return json(response, 200, games[game[1]]);
  return json(response, 404, { statusCode: 404, code: 'NOT_FOUND' });
}).listen(port, '127.0.0.1');
