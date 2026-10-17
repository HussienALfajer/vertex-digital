import { describe, expect, it } from 'vitest';
import { ApiError } from './api/client';
import { createIdempotentRequest } from './idempotency';

/** A sender with predictable keys, and the keys its requests were sent with. */
function sender() {
  let next = 0;
  const send = createIdempotentRequest(() => `key-${++next}`);
  const keys: string[] = [];
  const answer =
    (outcome: 'ok' | Error) =>
    async (key: string): Promise<string> => {
      keys.push(key);
      if (outcome instanceof Error) throw outcome;
      return key;
    };
  return { send, keys, answer };
}

const refusal = (status: number, code: string) => new ApiError(status, code, undefined, code);

describe('createIdempotentRequest (rule J9)', () => {
  it('keeps the key for the same body and takes a new one after a clear refusal', async () => {
    const { send, keys, answer } = sender();
    await expect(send({ amount: 5 }, answer(refusal(400, 'VALIDATION_FAILED')))).rejects.toThrow();
    await expect(
      send({ amount: 5 }, answer(refusal(409, 'INSUFFICIENT_BALANCE'))),
    ).rejects.toThrow();
    await send({ amount: 4 }, answer('ok'));
    expect(keys).toEqual(['key-1', 'key-1', 'key-2']);
  });

  it('keeps the key when a field changed after a lost answer (audit A1)', async () => {
    const { send, keys, answer } = sender();
    await expect(
      send({ amount: 25, note: 'a' }, answer(new TypeError('Failed to fetch'))),
    ).rejects.toThrow();
    // The first request may have been written: the edited one goes with the same key, so the API
    // answers IDEMPOTENCY_KEY_REUSED instead of writing a second adjustment.
    await expect(
      send({ amount: 25, note: 'b' }, answer(refusal(409, 'IDEMPOTENCY_KEY_REUSED'))),
    ).rejects.toThrow();
    await expect(
      send({ amount: 25, note: 'c' }, answer(refusal(400, 'VALIDATION_FAILED'))),
    ).rejects.toThrow();
    expect(keys).toEqual(['key-1', 'key-1', 'key-1']);
  });

  it('keeps the key after a server fault, until an answer comes back', async () => {
    const { send, keys, answer } = sender();
    await expect(send({ amount: 25 }, answer(refusal(502, 'BAD_GATEWAY')))).rejects.toThrow();
    await send({ amount: 30 }, answer('ok'));
    await send({ amount: 35 }, answer('ok'));
    expect(keys).toEqual(['key-1', 'key-1', 'key-2']);
  });
});
