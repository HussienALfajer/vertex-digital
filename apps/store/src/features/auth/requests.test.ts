import { describe, expect, it } from 'vitest';
import { registrationState, signIn, signUp } from './requests';

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

describe('signIn', () => {
  it('posts the credentials to the customer auth endpoint', async () => {
    const { fetch, calls } = fetcher([200, { token: 'x' }]);
    await expect(signIn('a@example.com', 'secret', { fetcher: fetch })).resolves.toMatchObject({
      ok: true,
    });
    expect(calls[0]?.url).toBe('/api/auth/sign-in/email');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: 'a@example.com',
      password: 'secret',
    });
  });

  it.each([
    [401, { code: 'INVALID_EMAIL_OR_PASSWORD' }, 'INVALID_EMAIL_OR_PASSWORD'],
    [403, { code: 'EMAIL_NOT_VERIFIED' }, 'EMAIL_NOT_VERIFIED'],
    [429, {}, 'RATE_LIMITED'],
    [500, {}, 'UNKNOWN'],
    [403, { code: 'SOMETHING_ELSE' }, 'UNKNOWN'],
  ])('maps %i %j to %s', async (status, body, reason) => {
    const { fetch } = fetcher([status, body]);
    await expect(signIn('a@example.com', 'x', { fetcher: fetch })).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it('reports a network failure', async () => {
    const failing = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    await expect(signIn('a@example.com', 'x', { fetcher: failing })).resolves.toEqual({
      ok: false,
      reason: 'NETWORK',
    });
  });

  it('does not send the sign-in again when the challenge cannot be fetched', async () => {
    const { fetch, calls } = fetcher([400, { code: 'ALTCHA_REQUIRED' }], [500, {}]);
    let verifying = false;
    const result = await signIn('a@example.com', 'x', {
      fetcher: fetch,
      onVerifying: () => {
        verifying = true;
      },
    });
    expect(result).toEqual({ ok: false, reason: 'ALTCHA_INVALID' });
    expect(verifying).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/auth/sign-in/email',
      '/api/altcha/challenge',
    ]);
  });
});

describe('signUp', () => {
  it('is not sent without a solved challenge', async () => {
    const { fetch, calls } = fetcher([429, { code: 'RATE_LIMITED' }]);
    const result = await signUp(
      { name: 'سارة', email: 'a@example.com', password: 'x', phone: '+963944123456' },
      fetch,
    );
    expect(result).toEqual({ ok: false, reason: 'ALTCHA_INVALID' });
    expect(calls.map((call) => call.url)).toEqual(['/api/altcha/challenge']);
    expect(header(calls[0], 'x-altcha')).toBeUndefined();
  });
});

describe('registrationState', () => {
  it.each([
    [200, { open: true }, 'open'],
    [200, { open: false }, 'closed'],
    [429, { code: 'RATE_LIMITED' }, 'failed'],
    [500, {}, 'failed'],
  ])('answers %i %j as %s', async (status, body, state) => {
    const { fetch } = fetcher([status, body]);
    await expect(registrationState(fetch)).resolves.toBe(state);
  });
});
