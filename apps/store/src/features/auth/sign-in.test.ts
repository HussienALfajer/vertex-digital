import { describe, expect, it } from 'vitest';
import { signIn } from './sign-in';

const answering = (status: number) => (async () => new Response('{}', { status })) as typeof fetch;

describe('signIn', () => {
  it('posts the credentials to the customer auth endpoint', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetcher = (async (url: string, init?: RequestInit) => {
      request = { url, init };
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await expect(signIn('a@example.com', 'secret', fetcher)).resolves.toEqual({ ok: true });
    expect(request?.url).toBe('/api/auth/sign-in/email');
    expect(request?.init?.method).toBe('POST');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      email: 'a@example.com',
      password: 'secret',
    });
  });

  it.each([
    [401, 'INVALID_EMAIL_OR_PASSWORD'],
    [429, 'RATE_LIMITED'],
    [500, 'UNKNOWN'],
    [403, 'UNKNOWN'],
  ])('maps %i to %s', async (status, reason) => {
    await expect(signIn('a@example.com', 'x', answering(status))).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it('reports a network failure', async () => {
    const fetcher = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(signIn('a@example.com', 'x', fetcher)).resolves.toEqual({
      ok: false,
      reason: 'NETWORK',
    });
  });
});
