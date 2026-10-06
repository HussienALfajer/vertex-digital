import type { Challenge } from 'altcha-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AltchaService } from '../src/core/altcha/index.js';
import { api, solveAltcha as solve } from './helpers.js';
import { ProbeController } from './probe.controller.js';
import { startApp, type TestApp } from './start-app.js';

/* ALTCHA (ADR 0008): a solved challenge opens a protected route once. */

let test: TestApp;
let client: ReturnType<typeof api>;

beforeAll(async () => {
  test = await startApp({ controllers: [ProbeController] });
  client = api(test.url);
});

afterAll(() => test.app.close());

async function fetchChallenge(): Promise<Challenge> {
  const response = await client.get('/api/altcha/challenge');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json()) as Challenge;
}

const submit = (payload?: string) =>
  client.post('/api/probe/altcha', {
    body: {},
    ...(payload !== undefined && { headers: { 'x-altcha': payload } }),
  });

describe('ALTCHA', () => {
  it('accepts a solved challenge once', async () => {
    const payload = await solve(await fetchChallenge());
    expect((await submit(payload)).status).toBe(200);
    expect(await (await submit(payload)).json()).toMatchObject({
      statusCode: 400,
      code: 'ALTCHA_INVALID',
    });
  });

  it('asks for a solution when none is sent', async () => {
    expect(await (await submit()).json()).toMatchObject({
      statusCode: 400,
      code: 'ALTCHA_REQUIRED',
    });
  });

  it('refuses a wrong solution, garbage, and a challenge it did not sign', async () => {
    const challenge = await fetchChallenge();
    expect((await submit(await solve(challenge, true))).status).toBe(400);
    expect((await submit('not-base64-json')).status).toBe(400);
    const forged = { ...challenge, signature: 'f'.repeat(64) };
    expect((await submit(await solve(forged))).status).toBe(400);
  });

  it('refuses an expired challenge', async () => {
    const service = test.app.get(AltchaService);
    const expired = await service.createChallenge(Date.now() - 11 * 60 * 1000);
    expect(await (await submit(await solve(expired))).json()).toMatchObject({
      code: 'ALTCHA_INVALID',
    });
  });
});
