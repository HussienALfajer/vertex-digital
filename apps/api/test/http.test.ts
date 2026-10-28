import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodedException } from '../src/core/errors/coded-exception.js';
import { errorResponseOf } from '../src/core/errors/error.filter.js';
import {
  LOG_REDACT_PATHS,
  LOG_SERIALIZERS,
  scrubEvent,
  withoutPrivateQuery,
} from '../src/core/http/secret-headers.js';
import { HealthController } from '../src/modules/health/health.controller.js';
import { HealthService } from '../src/modules/health/health.service.js';
import { api, body, clientIp } from './helpers.js';
import { ProbeController } from './probe.controller.js';
import { startApp, type TestApp } from './start-app.js';

/* The HTTP core: error shape (ADR 0011), origin checks (ADR 0007, 0008), rate limits, health. */

let test: TestApp;
let client: ReturnType<typeof api>;

beforeAll(async () => {
  test = await startApp({ controllers: [ProbeController] });
  client = api(test.url);
});

afterAll(() => test.app.close());

describe('errors', () => {
  it('answer validation failures with the issues', async () => {
    expect(
      await body(await client.post('/api/probe/echo', { body: { name: '', age: 1.5 } })),
    ).toEqual({
      status: 400,
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: 'Invalid input',
      details: [
        { path: ['name'], message: expect.any(String) },
        { path: ['age'], message: expect.any(String) },
      ],
    });
    expect((await client.post('/api/probe/echo', { body: { name: 'a', age: 3 } })).status).toBe(
      200,
    );
  });

  it('answer malformed JSON with BAD_REQUEST', async () => {
    const response = await client.request('POST', '/api/probe/echo', {
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const malformed = await fetch(`${test.url}/api/probe/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(await body(malformed)).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
  });

  it('answer unknown routes with NOT_FOUND', async () => {
    expect(await body(await client.get('/api/nothing-here'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('hide the internals of a server fault', async () => {
    const response = await client.get('/api/probe/crash');
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(text).not.toContain('secret internal detail');
  });
});

describe('origin checks', () => {
  it('refuse a state change from another origin, and accept one from the store', async () => {
    const payload = { body: { name: 'a', age: 3 } };
    expect(
      await body(
        await client.post('/api/probe/echo', { ...payload, origin: 'https://evil.example' }),
      ),
    ).toMatchObject({ status: 403, code: 'CROSS_ORIGIN_REFUSED' });
    expect(
      (await client.post('/api/probe/echo', { ...payload, origin: 'http://127.0.0.1:5173' }))
        .status,
    ).toBe(403);
    expect((await client.post('/api/probe/echo', payload)).status).toBe(200);
  });

  it('refuse a cross-site browser request without an Origin header', async () => {
    const response = await client.post('/api/probe/echo', {
      body: { name: 'a', age: 3 },
      origin: null,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
  });

  it('let requests without browser headers through (servers, webhooks)', async () => {
    const response = await client.post('/api/probe/echo', {
      body: { name: 'a', age: 3 },
      origin: null,
    });
    expect(response.status).toBe(200);
  });

  it('refuse any browser request to /api/admin that is not from the admin origin, reads included', async () => {
    for (const origin of ['http://127.0.0.1:3001', 'https://evil.example']) {
      expect(await body(await client.get('/api/admin/probe/admin', { origin }))).toMatchObject({
        status: 403,
        code: 'CROSS_ORIGIN_REFUSED',
      });
    }
    expect(
      (
        await client.get('/api/admin/probe/admin', {
          origin: null,
          headers: { 'sec-fetch-site': 'same-site' },
        })
      ).status,
    ).toBe(403);
    // From the admin origin it reaches the access check.
    expect((await client.get('/api/admin/probe/admin')).status).toBe(401);
  });

  it('apply the admin rule whatever the case of the path, with or without a query', async () => {
    for (const path of ['/API/ADMIN/probe/admin', '/Api/Admin/probe/admin', '/api/admin?x=1']) {
      expect((await client.get(path, { origin: 'http://127.0.0.1:3001' })).status, path).toBe(403);
    }
  });

  it('cover Better Auth routes too', async () => {
    const response = await client.post('/api/auth/sign-in/email', {
      body: { email: 'a@b.c', password: 'x' },
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
  });
});

describe('rate limits', () => {
  it('refuse a client over a route limit, and only that client', async () => {
    const ip = clientIp();
    expect((await client.get('/api/probe/limited', { ip })).status).toBe(200);
    expect((await client.get('/api/probe/limited', { ip })).status).toBe(200);
    expect(await body(await client.get('/api/probe/limited', { ip }))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
    expect((await client.get('/api/probe/limited')).status).toBe(200);
  });

  it("leave the store server's cached reads out, never a request nginx passed on (audit A10-36)", async () => {
    // The store's cached reads carry no visitor address: from this machine, marked, no
    // X-Forwarded-For. Over a route limit they still pass.
    const cached = () =>
      fetch(`${test.url}/api/probe/limited`, { headers: { 'x-store-cache-read': '1' } });
    for (let index = 0; index < 4; index += 1) expect((await cached()).status).toBe(200);
    // nginx sets X-Forwarded-For on every request from outside: the mark changes nothing then.
    const ip = clientIp();
    const marked = { ip, headers: { 'x-store-cache-read': '1' } };
    expect((await client.get('/api/probe/limited', marked)).status).toBe(200);
    expect((await client.get('/api/probe/limited', marked)).status).toBe(200);
    expect((await client.get('/api/probe/limited', marked)).status).toBe(429);
  });
});

describe('request ids (audit A10-37)', () => {
  it('name every request in X-Request-Id, a new id each time', async () => {
    const first = (await client.get('/api/probe/crash')).headers.get('x-request-id');
    const second = (await client.get('/api/health')).headers.get('x-request-id');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});

describe('Sentry (audit A10-38)', () => {
  it('gets server faults only, never a refusal', () => {
    expect(errorResponseOf(new Error('boom')).fault).toBe(true);
    expect(errorResponseOf(new CodedException(409, 'IDEMPOTENCY_KEY_REUSED', 'taken')).fault).toBe(
      false,
    );
    expect(errorResponseOf(Object.assign(new Error('too large'), { status: 413 })).fault).toBe(
      false,
    );
  });

  it('never gets cookies, bodies, secret headers or a search', () => {
    const event = scrubEvent({
      request: {
        cookies: { 'vd.session_token': 'secret' },
        data: '{"password":"secret"}',
        headers: {
          cookie: 'vd.session_token=secret',
          authorization: 'Bearer secret',
          'x-altcha': 'secret',
          'x-telegram-bot-api-secret-token': 'secret',
          referer: 'https://digital-admin.vertexmedia.pro/customers?q=layla%40example.com',
          accept: 'application/json',
        },
        url: 'https://digital-admin.vertexmedia.pro/api/admin/customers?q=layla%40example.com&page=2',
        query_string: 'q=layla%40example.com&page=2',
      },
    });
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(JSON.stringify(event)).not.toContain('layla');
    expect(event.request).toEqual({
      headers: {
        referer: 'https://digital-admin.vertexmedia.pro/customers?q=REDACTED',
        accept: 'application/json',
      },
      url: 'https://digital-admin.vertexmedia.pro/api/admin/customers?q=REDACTED&page=2',
      query_string: 'q=REDACTED&page=2',
    });
    // A query Sentry parsed into pairs is dropped, not checked pair by pair.
    expect(scrubEvent({ request: { query_string: [['q', 'layla']] } }).request).toEqual({});
  });
});

describe('health', () => {
  it('reports the database up', async () => {
    const response = await client.get('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { database: 'up' },
      timestamp: expect.any(String),
    });
  });

  it('answers 503 with the database down (audit A10-39)', async () => {
    const down = new HealthService({ execute: () => Promise.reject(new Error('down')) } as never);
    const status: number[] = [];
    const response = { status: (code: number) => status.push(code) };
    expect(await new HealthController(down).check(response as never)).toMatchObject({
      status: 'error',
      checks: { database: 'down' },
    });
    expect(status).toEqual([503]);
  });
});

describe('OpenAPI', () => {
  it('serves the document outside production', async () => {
    const response = await client.get('/api/docs-json');
    expect(response.status).toBe(200);
    const document = (await response.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths)).toContain('/api/health');
  });
});

describe('logs', () => {
  it('never write a credential header, the Telegram webhook secret included (ADR 0008)', () => {
    let written = '';
    const sink = new Writable({
      write(chunk, _encoding, done) {
        written += chunk.toString();
        done();
      },
    });
    const logger = pino({ redact: LOG_REDACT_PATHS }, sink);
    logger.info({
      req: {
        headers: {
          cookie: 'session=cookie-value',
          authorization: 'Bearer bearer-value',
          'x-altcha': 'altcha-value',
          'x-telegram-bot-api-secret-token': 'telegram-secret-value',
          'user-agent': 'TelegramBot',
        },
      },
      res: { headers: { 'set-cookie': 'session=set-value' } },
    });
    for (const value of [
      'cookie-value',
      'bearer-value',
      'altcha-value',
      'telegram-secret-value',
      'set-value',
    ]) {
      expect(written).not.toContain(value);
    }
    expect(written).toContain('TelegramBot');
  });

  it("never write a search's terms: not in the URL, the query or the referer (audit A5)", () => {
    let written = '';
    const sink = new Writable({
      write(chunk, _encoding, done) {
        written += chunk.toString();
        done();
      },
    });
    const logger = pino({ redact: LOG_REDACT_PATHS, serializers: LOG_SERIALIZERS }, sink);
    logger.info({
      req: {
        method: 'GET',
        url: '/api/admin/wallets?q=0933123456&limit=30',
        query: { q: '0933123456', limit: '30' },
        headers: {
          cookie: 'session=cookie-value',
          referer: 'https://digital-admin.vertexmedia.pro/wallets?q=0933123456',
        },
      },
    });
    expect(written).not.toContain('0933123456');
    expect(written).not.toContain('cookie-value');
    expect(written).toContain('/api/admin/wallets?q=REDACTED&limit=30');
    expect(written).toContain('"limit":"30"');
  });

  it('leaves a URL without private parameters as it is', () => {
    expect(withoutPrivateQuery('/api/admin/wallets/abc')).toBe('/api/admin/wallets/abc');
    expect(withoutPrivateQuery('/api/orders?cursor=x')).toBe('/api/orders?cursor=x');
    expect(withoutPrivateQuery('https://a.test/x?q=a%40b.c&q=d')).toBe(
      'https://a.test/x?q=REDACTED',
    );
  });
});
