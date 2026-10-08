import { createChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { describe, expect, it } from 'vitest';
import {
  cancelDeposit,
  createShamCashDeposit,
  getDeposit,
  listDeposits,
  submitReceipt,
} from './requests';

type Call = { url: string; init?: RequestInit };

/** A fetch that answers each call with the next response and records what was sent. */
function fetcher(...answers: [status: number, body: unknown][]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const header = (call: Call | undefined, name: string) =>
  (call?.init?.headers as Record<string, string> | undefined)?.[name];

const DEPOSIT_ID = '0199a000-0000-7000-8000-0000000000d1';

describe('createShamCashDeposit', () => {
  it('solves the challenge, then sends the attempt’s key with the body', async () => {
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 10,
      counter: 1,
      deriveKey,
      hmacSignatureSecret: 'test-only-hmac-key',
    });
    const { fetch, calls } = fetcher([200, challenge], [201, { id: DEPOSIT_ID }]);
    const result = await createShamCashDeposit(
      { currency: 'SYP', amountUnits: 200_000 },
      'key-1',
      fetch,
    );
    expect(result).toEqual({ ok: true, data: { id: DEPOSIT_ID } });
    expect(calls.map((call) => call.url)).toEqual([
      '/api/altcha/challenge',
      '/api/deposits/sham-cash',
    ]);
    expect(header(calls[1], 'idempotency-key')).toBe('key-1');
    expect(header(calls[1], 'x-altcha')).toBeTruthy();
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      currency: 'SYP',
      amountUnits: 200_000,
    });
  });

  it('is not sent without a solved challenge', async () => {
    const { fetch, calls } = fetcher([500, {}]);
    const result = await createShamCashDeposit({ currency: 'USD', amountUnits: 1 }, 'k', fetch);
    expect(result).toEqual({ ok: false, reason: 'ALTCHA_INVALID' });
    expect(calls).toHaveLength(1);
  });
});

describe('submitReceipt', () => {
  it('sends the image and the rate seen as multipart', async () => {
    const { fetch, calls } = fetcher([200, { id: DEPOSIT_ID }]);
    const file = new Blob(['png'], { type: 'image/png' });
    await submitReceipt(DEPOSIT_ID, file, 'rate-1', fetch);
    const body = calls[0]?.init?.body as FormData;
    expect(calls[0]?.url).toBe(`/api/deposits/${DEPOSIT_ID}/receipt`);
    expect(body.get('rateId')).toBe('rate-1');
    expect(body.get('file')).toBeInstanceOf(Blob);
    // The browser sets the multipart boundary itself.
    expect(header(calls[0], 'content-type')).toBeUndefined();
  });

  it('keeps the refusal’s details for the screen', async () => {
    const offer = { rateId: 'rate-2', rate: '130', declaredUsdUnits: 15_380_000 };
    const { fetch } = fetcher([409, { code: 'QUOTE_EXPIRED', details: offer }]);
    const result = await submitReceipt(DEPOSIT_ID, new Blob(['x']), null, fetch);
    expect(result).toEqual({ ok: false, reason: 'QUOTE_EXPIRED', details: offer });
  });
});

describe('the other deposit routes', () => {
  it('read and cancel by id, and page with the cursor', async () => {
    const { fetch, calls } = fetcher(
      [200, {}],
      [404, { code: 'NOT_FOUND' }],
      [200, {}],
      [200, { items: [], nextCursor: null }],
    );
    await cancelDeposit(DEPOSIT_ID, fetch);
    await expect(getDeposit('a/b', fetch)).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    await listDeposits(undefined, fetch);
    await listDeposits('next page', fetch);
    expect(calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`)).toEqual([
      `POST /api/deposits/${DEPOSIT_ID}/cancel`,
      'GET /api/deposits/a%2Fb',
      'GET /api/deposits',
      'GET /api/deposits?cursor=next+page',
    ]);
  });
});
