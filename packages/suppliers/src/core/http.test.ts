import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type FakeHttpServer, startFakeHttpServer } from '../testing/fake-http-server.js';
import { outcomeOfOrderError, SupplierError } from './errors.js';
import { networkFailure, SupplierHttp } from './http.js';

let server: FakeHttpServer;
let http: SupplierHttp;

beforeAll(async () => {
  server = await startFakeHttpServer();
  http = new SupplierHttp({
    baseUrl: `${server.url}/api/v1/`,
    // Generous: a busy CI runner must not turn an ordinary reply into a timeout. The timeout test
    // uses its own short one.
    timeoutMs: 5_000,
    headers: { authorization: 'Bearer test-key' },
  });
});

afterAll(() => server.close());

const balanceSchema = z.object({ balance: z.string() });
const errorCode = (body: unknown) => (body as { code?: string } | undefined)?.code;

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SupplierError);
  return error as SupplierError;
};

describe('SupplierHttp', () => {
  it('sends JSON with the credentials and parses the reply', async () => {
    server.reply({ body: { balance: '12.50', extra: true } });
    const result = await http.request({
      method: 'POST',
      path: 'balance',
      body: { currency: 'USD' },
      schema: balanceSchema,
    });
    expect(result).toEqual({ balance: '12.50' });
    const sent = server.requests.at(-1);
    expect(sent).toMatchObject({
      method: 'POST',
      path: '/api/v1/balance',
      body: '{"currency":"USD"}',
    });
    expect(sent?.headers).toMatchObject({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    });
  });

  it('treats an unexpected reply as retryable, never trusted', async () => {
    server.reply({ body: { balance: 12.5 } });
    expect(
      (await failure(http.request({ method: 'GET', path: 'balance', schema: balanceSchema }))).kind,
    ).toBe('retryable');
    server.reply({ body: 'not json' });
    expect(
      (await failure(http.request({ method: 'GET', path: 'balance', schema: balanceSchema }))).kind,
    ).toBe('retryable');
  });

  const refusal = (status: number, code: string) => {
    server.reply({ status, body: { code } });
    return failure(
      http.request({
        method: 'POST',
        path: 'orders',
        schema: balanceSchema,
        errorCode,
        definitiveCodes: ['INVALID_PLAYER', 'IN_PROGRESS'],
      }),
    );
  };

  it('classifies a refusal as definitive only when the adapter maps its code', async () => {
    expect(await refusal(422, 'INVALID_PLAYER')).toMatchObject({
      kind: 'definitive',
      details: { status: 422, supplierCode: 'INVALID_PLAYER' },
    });
    expect(await refusal(400, 'SOMETHING_NEW')).toMatchObject({
      kind: 'retryable',
      details: { status: 400, supplierCode: 'SOMETHING_NEW' },
    });
    server.reply({ status: 403, body: 'Forbidden' });
    expect(
      (await failure(http.request({ method: 'GET', path: 'x', schema: balanceSchema, errorCode })))
        .kind,
    ).toBe('retryable');
  });

  it('keeps timeouts, conflicts, rate limits and 5xx retryable, even with a mapped code', async () => {
    for (const status of [408, 409, 425, 429, 500, 503]) {
      expect((await refusal(status, 'IN_PROGRESS')).kind).toBe('retryable');
    }
  });

  it('turns a repeated order key the supplier answers with 409 into unknown, never failed', async () => {
    expect(outcomeOfOrderError(await refusal(409, 'IN_PROGRESS'))).toMatchObject({
      status: 'unknown',
    });
  });

  it('times out a supplier that does not answer', async () => {
    server.reply({ delayMs: 1_000, body: { balance: '1' } });
    const impatient = new SupplierHttp({ baseUrl: `${server.url}/api/v1/`, timeoutMs: 200 });
    const timedOut = await failure(
      impatient.request({ method: 'GET', path: 'x', schema: balanceSchema }),
    );
    expect(timedOut).toMatchObject({ kind: 'retryable', message: 'Supplier timed out' });
  });

  it('reports an unreachable supplier as retryable', async () => {
    const down = new SupplierHttp({ baseUrl: 'http://127.0.0.1:9/' });
    expect(
      await failure(down.request({ method: 'GET', path: 'x', schema: balanceSchema })),
    ).toMatchObject({
      kind: 'retryable',
      // Port 9 is one `fetch` refuses to use: no socket error code.
      message: 'Supplier unreachable (other)',
      details: { failure: 'other' },
    });
  });

  it('keeps the status, the failure and when a rate limit lifts (S18 FK1)', async () => {
    server.reply(
      { status: 429, body: {}, headers: { 'x-ratelimit-reset': '1792430640' } },
      { status: 429, body: {}, headers: { 'retry-after': '7' } },
      { status: 429, body: {} },
      { status: 503, body: {} },
      { status: 400, body: {} },
    );
    const read = () => failure(http.request({ method: 'GET', path: 'x', schema: balanceSchema }));
    expect(await read()).toMatchObject({
      details: { status: 429, failure: 'rate_limited', retryAt: 1_792_430_640_000 },
    });
    const before = Date.now();
    const after = (await read()) as SupplierError;
    expect(after.details.retryAt).toBeGreaterThanOrEqual(before + 7_000);
    expect((await read()) as SupplierError).not.toHaveProperty('details.retryAt');
    expect(await read()).toMatchObject({ details: { failure: 'http_5xx' } });
    expect(await read()).toMatchObject({ details: { failure: 'http_4xx' } });
  });
});

describe('networkFailure (S18 FK1)', () => {
  const coded = (code: string) =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

  it('tells a timeout, DNS, a connection and TLS apart', () => {
    expect(networkFailure(new DOMException('late', 'TimeoutError'))).toBe('timeout');
    expect(networkFailure(coded('ENOTFOUND'))).toBe('dns');
    expect(networkFailure(coded('EAI_AGAIN'))).toBe('dns');
    expect(networkFailure(coded('ECONNREFUSED'))).toBe('connect');
    expect(networkFailure(coded('UND_ERR_CONNECT_TIMEOUT'))).toBe('connect');
    expect(networkFailure(coded('CERT_HAS_EXPIRED'))).toBe('tls');
    expect(networkFailure(coded('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls');
    expect(networkFailure(coded('ESOMETHING'))).toBe('other');
    expect(networkFailure(new Error('no code'))).toBe('other');
    expect(networkFailure('not an error')).toBe('other');
  });
});

describe('SupplierHttp redirects', () => {
  it('follows a read to the same origin, with the credentials', async () => {
    server.reply(
      { status: 301, headers: { location: '/api/v1/balance/' } },
      { body: { balance: '3.00' } },
    );
    const before = server.requests.length;
    const result = await http.request({ method: 'GET', path: 'balance', schema: balanceSchema });
    expect(result).toEqual({ balance: '3.00' });
    const sent = server.requests.slice(before);
    expect(sent.map((request) => request.path)).toEqual(['/api/v1/balance', '/api/v1/balance/']);
    expect(sent[1]?.headers).toMatchObject({ authorization: 'Bearer test-key' });
  });

  it('never carries the credentials to another origin', async () => {
    server.reply({ status: 302, headers: { location: 'http://127.0.0.2:9/steal' } });
    const error = await failure(
      http.request({ method: 'GET', path: 'balance', schema: balanceSchema }),
    );
    expect(error).toMatchObject({ kind: 'retryable', details: { status: 302 } });
  });

  it('refuses a redirected order (its outcome stays unknown) and a redirect without end', async () => {
    server.reply({ status: 307, headers: { location: '/api/v1/orders/2' } });
    const order = await failure(
      http.request({ method: 'POST', path: 'orders', body: {}, schema: balanceSchema }),
    );
    expect(outcomeOfOrderError(order).status).toBe('unknown');
    server.reply({ status: 302, headers: { location: '/api/v1/loop' } });
    const before = server.requests.length;
    const loop = await failure(
      http.request({ method: 'GET', path: 'loop', schema: balanceSchema }),
    );
    expect(loop.kind).toBe('retryable');
    expect(server.requests.length - before).toBe(4);
  });
});

describe('outcomeOfOrderError', () => {
  it('fails an order only on a definitive refusal', () => {
    expect(
      outcomeOfOrderError(
        new SupplierError('definitive', 'Refused', { status: 422, supplierCode: 'OUT_OF_STOCK' }),
      ),
    ).toEqual({ status: 'failed_definitive', reason: 'Refused', supplierCode: 'OUT_OF_STOCK' });
    expect(outcomeOfOrderError(new SupplierError('definitive', 'Refused'))).toEqual({
      status: 'failed_definitive',
      reason: 'Refused',
    });
  });

  it('treats a lost or unreadable answer as unknown, never as failed', () => {
    expect(
      outcomeOfOrderError(
        new SupplierError('retryable', 'Supplier timed out', { failure: 'timeout' }),
      ),
    ).toEqual({ status: 'unknown', reason: 'Supplier timed out', failure: 'timeout' });
    expect(
      outcomeOfOrderError(
        new SupplierError('retryable', 'HTTP 404', { status: 404, supplierCode: 'NOT_FOUND' }),
      ),
    ).toEqual({
      status: 'unknown',
      reason: 'HTTP 404',
      failure: 'other',
      httpStatus: 404,
      supplierCode: 'NOT_FOUND',
    });
    expect(outcomeOfOrderError(new Error('socket hang up'))).toMatchObject({ status: 'unknown' });
    expect(outcomeOfOrderError('weird')).toEqual({
      status: 'unknown',
      reason: 'weird',
      failure: 'other',
    });
  });
});
