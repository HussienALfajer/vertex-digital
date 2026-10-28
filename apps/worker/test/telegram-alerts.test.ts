import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scrubBreadcrumb } from '../src/core/alerts/scrub-breadcrumb.js';
import { TelegramAlerts } from '../src/core/alerts/telegram-alerts.js';
import { TelegramBot } from '../src/telegram/bot-api.js';
import { LinkedChat } from '../src/telegram/linked-chat.js';

/*
 * The admin alert channel against a local fake Bot API: nothing calls Telegram in tests. The chat
 * is the live link's (S05 rule AL1), given here by a function.
 */

interface Received {
  path: string;
  body: { chat_id: number; text: string };
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

/** `null`: no token. */
const bot = (url = apiUrl, botToken: string | null = '123:abc') =>
  new TelegramBot({ transport: 'api', botToken: botToken ?? undefined, apiUrl: url, logDir: '' });

const channel = (chatId: number | null = 4200) =>
  new TelegramAlerts({ source: 'worker test' }, bot(), async () => chatId);

describe('Telegram alerts', () => {
  it('send to the linked chat through the Bot API', async () => {
    expect(await channel().send('Supplier wdgzone is down')).toBe(true);
    expect(received).toEqual([
      {
        path: '/bot123:abc/sendMessage',
        body: { chat_id: 4200, text: '[worker test] Supplier wdgzone is down' },
      },
    ]);
  });

  it('are off without a token, and send nothing', async () => {
    const off = new TelegramAlerts({ source: 'worker test' }, bot(apiUrl, null), async () => 1);
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
    const unreachable = new TelegramAlerts(
      { source: 'worker test' },
      bot('http://127.0.0.1:9'),
      async () => 4200,
    );
    expect(await unreachable.send('unreachable')).toBe(false);
  });

  it('are logged and dropped while no chat is linked', async () => {
    expect(await channel(null).send('nobody linked')).toBe(false);
    expect(received).toEqual([]);
  });

  it('still reach the chat read last while the database is down (audit A10-52)', async () => {
    let down = false;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            if (down) throw new Error('connection refused');
            return [{ chatId: 4200 }];
          },
        }),
      }),
    };
    const chat = new LinkedChat(db as never);
    const start = Date.now();
    expect(await chat.chatId(start)).toBe(4200);
    down = true;
    expect(await chat.chatId(start + 61_000)).toBe(4200);
    const alerts = new TelegramAlerts({ source: 'worker test' }, bot(), () =>
      chat.chatId(start + 120_000),
    );
    expect(await alerts.send('the database is down')).toBe(true);
    expect(received.map((message) => message.body.chat_id)).toEqual([4200]);
    // With no chat ever read, the failure stays a failure: nothing is sent to a guess.
    await expect(new LinkedChat(db as never).chatId(start)).rejects.toThrow('connection refused');
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

  it('never reach Sentry with a chain provider key, in a path, a query or user info (audit A2)', () => {
    const secrets = ['k3y-in-path', 'k3y-in-query', 'us3r', 'pa55'];
    const breadcrumb = scrubBreadcrumb({
      category: 'http',
      message: 'POST https://bsc-mainnet.example-rpc.io/v1/k3y-in-path',
      data: {
        url: 'https://us3r:pa55@bsc.example-rpc.io/rpc?apikey=k3y-in-query',
        'http.query': 'apikey=k3y-in-query',
        'http.method': 'POST',
        status_code: 200,
      },
    });
    expect(breadcrumb).toEqual({
      category: 'http',
      message: 'POST https://bsc-mainnet.example-rpc.io/[redacted]',
      data: {
        url: 'https://bsc.example-rpc.io/[redacted]',
        'http.method': 'POST',
        status_code: 200,
      },
    });
    for (const secret of secrets) expect(JSON.stringify(breadcrumb)).not.toContain(secret);
    // An origin alone stays as it is.
    expect(scrubBreadcrumb({ message: 'GET https://api.trongrid.io' }).message).toBe(
      'GET https://api.trongrid.io',
    );
  });
});
