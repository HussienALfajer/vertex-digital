import { describe, expect, it } from 'vitest';
import type { Failure, Result } from './api';
import { createIdempotentRequest, mayHaveLanded } from './idempotency';

function keys() {
  let next = 0;
  return () => `key-${++next}`;
}

/** Sends `body` and answers `result`, returning the key it was sent with. */
async function sendWith(
  send: ReturnType<typeof createIdempotentRequest>,
  body: string,
  result: Result<unknown>,
): Promise<string> {
  let sent = '';
  await send(body, async (key) => {
    sent = key;
    return result;
  });
  return sent;
}

const ok: Result<unknown> = { ok: true, data: {} };
const refused = (reason: Failure): Result<unknown> => ({ ok: false, reason });

describe('mayHaveLanded', () => {
  it('counts no answer, a server fault and a reused key, not a clear refusal', () => {
    for (const reason of [
      'NETWORK',
      'UNKNOWN',
      'INTERNAL_ERROR',
      'IDEMPOTENCY_KEY_REUSED',
    ] as const)
      expect(mayHaveLanded(reason)).toBe(true);
    for (const reason of ['VALIDATION_FAILED', 'RATE_LIMITED', 'UNAUTHORIZED'] as const)
      expect(mayHaveLanded(reason)).toBe(false);
  });
});

describe('createIdempotentRequest (F6-14)', () => {
  it('keeps the key for the same body and changes it after a clear refusal of another', async () => {
    const send = createIdempotentRequest(keys());
    const first = await sendWith(send, 'a', refused('VALIDATION_FAILED'));
    expect(await sendWith(send, 'a', refused('VALIDATION_FAILED'))).toBe(first);
    expect(await sendWith(send, 'b', ok)).not.toBe(first);
  });

  it.each(['NETWORK', 'UNKNOWN', 'INTERNAL_ERROR'] as const)(
    'keeps the key for an edited body after %s',
    async (reason) => {
      const send = createIdempotentRequest(keys());
      const first = await sendWith(send, 'a', refused(reason));
      // The edited retry goes with the first key: the API refuses it if the first was written.
      expect(await sendWith(send, 'b', refused('IDEMPOTENCY_KEY_REUSED'))).toBe(first);
      // Still unknown: a further edit keeps it too, and a clear refusal does not free it.
      expect(await sendWith(send, 'c', refused('RATE_LIMITED'))).toBe(first);
      expect(await sendWith(send, 'd', ok)).toBe(first);
    },
  );

  it('starts a new attempt after a success', async () => {
    const send = createIdempotentRequest(keys());
    const first = await sendWith(send, 'a', refused('NETWORK'));
    expect(await sendWith(send, 'b', ok)).toBe(first);
    expect(await sendWith(send, 'b', ok)).not.toBe(first);
  });
});
