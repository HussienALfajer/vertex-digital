import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scrubBreadcrumb } from '../src/core/alerts/scrub-breadcrumb.js';
import { TelegramAlerts } from '../src/core/alerts/telegram-alerts.js';

/* The admin alert channel against a local fake Bot API: nothing calls Telegram in tests. */

interface Received {
  path: string;
  body: { chat_id: string; text: string };
}

let server: Server;
let apiUrl: string;
let received: Received[] = [];
let status = 200;

beforeAll(async () => {
  server = createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => {
      received.push({ path: request.url ?? '', body: JSON.parse(data) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: status === 200 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  received = [];
  status = 200;
});

const channel = () =>
  new TelegramAlerts({ botToken: '123:abc', chatId: '-100200', apiUrl, source: 'worker test' });

describe('Telegram alerts', () => {
  it('send to the configured chat through the Bot API', async () => {
    expect(await channel().send('Supplier wdgzone is down')).toBe(true);
    expect(received).toEqual([
      {
        path: '/bot123:abc/sendMessage',
        body: { chat_id: '-100200', text: '[worker test] Supplier wdgzone is down' },
      },
    ]);
  });

  it('are off without a token, and send nothing', async () => {
    const off = new TelegramAlerts({ apiUrl, source: 'worker test' });
    expect(off.enabled).toBe(false);
    expect(await off.send('anything')).toBe(false);
    expect(received).toEqual([]);
  });

  it('send a repeated text once in ten minutes, then report what was held back', async () => {
    const alerts = channel();
    const start = Date.now();
    expect(await alerts.send('same', start)).toBe(true);
    expect(await alerts.send('same', start + 1_000)).toBe(false);
    expect(await alerts.send('same', start + 11 * 60_000)).toBe(true);
    expect(received.map((message) => message.body.text)).toEqual([
      '[worker test] same',
      '[worker test] same\n(1 more alerts suppressed)',
    ]);
  });

  it('send at most 15 a minute', async () => {
    const alerts = channel();
    const start = Date.now();
    const results = [];
    for (let i = 0; i < 20; i += 1) results.push(await alerts.send(`alert ${i}`, start + i));
    expect(results.filter(Boolean)).toHaveLength(15);
    expect(await alerts.send('after a minute', start + 61_000)).toBe(true);
  });

  it('never throw when Telegram refuses or cannot be reached', async () => {
    status = 401;
    expect(await channel().send('refused')).toBe(false);
    const unreachable = new TelegramAlerts({
      botToken: '123:abc',
      chatId: '-100200',
      apiUrl: 'http://127.0.0.1:9',
      source: 'worker test',
    });
    expect(await unreachable.send('unreachable')).toBe(false);
  });

  it('never reach Sentry with the token: request breadcrumbs are scrubbed', () => {
    const url = `${apiUrl}/bot123:abc/sendMessage`;
    expect(
      scrubBreadcrumb({
        category: 'http',
        message: `POST ${url}`,
        data: { url, 'http.method': 'POST', status_code: 200 },
      }),
    ).toEqual({
      category: 'http',
      message: `POST ${apiUrl}/bot[redacted]/sendMessage`,
      data: { url: `${apiUrl}/bot[redacted]/sendMessage`, 'http.method': 'POST', status_code: 200 },
    });
    expect(scrubBreadcrumb({ category: 'console' })).toEqual({ category: 'console' });
  });
});
