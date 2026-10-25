import { describe, expect, it } from 'vitest';
import {
  authorizePasskey,
  type Browser,
  listPasskeys,
  registerPasskey,
  removePasskey,
  renamePasskey,
  signInWithPasskey,
} from './requests';

type Call = { url: string; init?: RequestInit };

/** A fetch that answers each call with the next response and records what was sent. */
function fetcher(...answers: [status: number, body: unknown][]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = answers.shift() ?? [500, {}];
    // A 204 carries no body, as the API sends it.
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const sent = (call: Call | undefined) => JSON.parse(String(call?.init?.body));

/** A browser whose prompts answer, or refuse with a WebAuthn error of `name`. */
const browser = (refusal?: string) => {
  const inputs: unknown[] = [];
  const answer = async (input: unknown) => {
    inputs.push(input);
    if (refusal) throw Object.assign(new Error(refusal), { name: refusal });
    return { id: 'credential' };
  };
  const fake: Browser = { startRegistration: answer, startAuthentication: answer };
  return { load: async () => fake, inputs };
};

describe('management', () => {
  it('lists, authorizes, renames and removes under /api/account/passkeys', async () => {
    const { fetch, calls } = fetcher([200, []], [204, null], [200, { id: 'a' }], [204, null]);
    await expect(listPasskeys(fetch)).resolves.toEqual({ ok: true, data: [] });
    await expect(authorizePasskey('secret', fetch)).resolves.toMatchObject({ ok: true });
    await renamePasskey('a/b', 'هاتفي', fetch);
    await removePasskey('a', fetch);
    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', '/api/account/passkeys'],
      ['POST', '/api/account/passkeys/authorize'],
      ['PATCH', '/api/account/passkeys/a%2Fb'],
      ['DELETE', '/api/account/passkeys/a'],
    ]);
    expect(sent(calls[1])).toEqual({ password: 'secret' });
    expect(sent(calls[2])).toEqual({ name: 'هاتفي' });
  });
});

describe('registerPasskey', () => {
  it('asks the options, runs the prompt with them and sends its answer', async () => {
    const { fetch, calls } = fetcher([200, { challenge: 'c' }], [200, { id: 'p', name: 'iOS' }]);
    const fake = browser();
    await expect(registerPasskey(fetch, fake.load)).resolves.toEqual({
      ok: true,
      data: { id: 'p', name: 'iOS' },
    });
    expect(fake.inputs).toEqual([{ optionsJSON: { challenge: 'c' } }]);
    expect(calls[1]?.url).toBe('/api/auth/passkey/register');
    expect(sent(calls[1])).toEqual({ response: { id: 'credential' } });
  });

  it('stops at a refused grant without a prompt', async () => {
    const { fetch, calls } = fetcher([403, { code: 'REAUTHENTICATION_REQUIRED' }]);
    const fake = browser();
    await expect(registerPasskey(fetch, fake.load)).resolves.toEqual({
      ok: false,
      reason: 'REAUTHENTICATION_REQUIRED',
    });
    expect(fake.inputs).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['NotAllowedError', 'CANCELLED'],
    ['AbortError', 'CANCELLED'],
    ['InvalidStateError', 'ALREADY_REGISTERED'],
    ['SecurityError', 'UNKNOWN'],
  ])('maps a prompt refused with %s to %s', async (name, reason) => {
    const { fetch, calls } = fetcher([200, { challenge: 'c' }]);
    await expect(registerPasskey(fetch, browser(name).load)).resolves.toEqual({
      ok: false,
      reason,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('signInWithPasskey', () => {
  it('passes the autofill choice to the prompt and signs in with its answer', async () => {
    const { fetch, calls } = fetcher([200, { challenge: 'c' }], [200, { status: true }]);
    const fake = browser();
    await expect(signInWithPasskey({ autofill: true }, fetch, fake.load)).resolves.toMatchObject({
      ok: true,
    });
    expect(fake.inputs).toEqual([{ optionsJSON: { challenge: 'c' }, useBrowserAutofill: true }]);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/auth/passkey/sign-in-options',
      '/api/auth/sign-in/passkey',
    ]);
  });

  it('answers a refused sign-in by its code', async () => {
    const { fetch } = fetcher(
      [200, { challenge: 'c' }],
      [401, { code: 'INVALID_EMAIL_OR_PASSWORD' }],
    );
    await expect(signInWithPasskey({}, fetch, browser().load)).resolves.toEqual({
      ok: false,
      reason: 'INVALID_EMAIL_OR_PASSWORD',
    });
  });

  it('stops when the options are refused or the prompt is closed', async () => {
    await expect(signInWithPasskey({}, fetcher([429, {}]).fetch, browser().load)).resolves.toEqual({
      ok: false,
      reason: 'RATE_LIMITED',
    });
    await expect(
      signInWithPasskey({}, fetcher([200, {}]).fetch, browser('NotAllowedError').load),
    ).resolves.toEqual({ ok: false, reason: 'CANCELLED' });
  });
});
