import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Failure, Result } from '@/lib/api';
import { clearAttempt, sendAttempt } from './attempt';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const ok: Result<unknown> = { ok: true, data: {} };
const refused = (reason: Failure): Result<unknown> => ({ ok: false, reason });

/** Sends `body` for `product` and answers `result`, returning the key it was sent with. */
async function keyOf(
  product: string,
  body: string,
  result: Result<unknown> = refused('RATE_LIMITED'),
) {
  let sent = '';
  await sendAttempt(
    product,
    body,
    async (key) => {
      sent = key;
      return result;
    },
    frees,
  );
  return sent;
}

/** As the buy box: a refusal after the lookup frees the key, a schema refusal only when settled. */
const frees = (reason: Failure, unsettled: boolean) =>
  reason === 'PRICE_CHANGED' ||
  reason === 'IDEMPOTENCY_KEY_REUSED' ||
  (reason === 'VALIDATION_FAILED' && !unsettled);

afterEach(() => vi.unstubAllGlobals());

describe('sendAttempt (rule BB6)', () => {
  it('reuses the key for the same body across remounts, a new one for another body', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    const first = await keyOf('p1', '{"a":1}');
    expect(await keyOf('p1', '{"a":1}')).toBe(first);
    const other = await keyOf('p1', '{"a":2}');
    expect(other).not.toBe(first);
    expect(await keyOf('p2', '{"a":2}')).not.toBe(other);
    clearAttempt('p1');
    expect(await keyOf('p1', '{"a":2}')).not.toBe(other);
  });

  it('keeps the key for an edited body after a lost answer, across a reload (F6-14)', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    const first = await keyOf('p6', '{"player":"1"}', refused('NETWORK'));
    // A reload: the module's memory is gone, session storage holds the unsettled attempt.
    clearMemoryOnly('p6', storage);
    expect(await keyOf('p6', '{"player":"2"}', refused('INTERNAL_ERROR'))).toBe(first);
    // A refusal answered before the key lookup proves nothing of the first: the key stays.
    expect(await keyOf('p6', '{"player":"3"}', refused('VALIDATION_FAILED'))).toBe(first);
    expect(await keyOf('p6', '{"player":"4"}', refused('RATE_LIMITED'))).toBe(first);
    // The order: the next purchase is a new attempt.
    expect(await keyOf('p6', '{"player":"4"}', ok)).toBe(first);
    expect(await keyOf('p6', '{"player":"4"}')).not.toBe(first);
  });

  it('starts over after IDEMPOTENCY_KEY_REUSED: the first was written (F6-14)', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    const first = await keyOf('p7', '{"player":"1"}', refused('NETWORK'));
    expect(await keyOf('p7', '{"player":"2"}', refused('IDEMPOTENCY_KEY_REUSED'))).toBe(first);
    // The customer was told to check the orders; a new slide is a new purchase.
    expect(await keyOf('p7', '{"player":"2"}')).not.toBe(first);
  });

  it('keeps the key for a body edited while the first is still in flight (A04-1)', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    let answer: (result: Result<unknown>) => void = () => {};
    let firstKey = '';
    const first = sendAttempt<unknown>(
      'p9',
      '{"lines":2}',
      (key) => {
        firstKey = key;
        return new Promise<Result<unknown>>((resolve) => {
          answer = resolve;
        });
      },
      frees,
    );
    // The cart edited and sent again before the first checkout answered: the same key.
    expect(await keyOf('p9', '{"lines":1}', refused('IDEMPOTENCY_KEY_REUSED'))).toBe(firstKey);
    answer(ok);
    await first;
  });

  it('frees the key on a schema refusal when no answer was lost', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    const first = await keyOf('p8', 'body', refused('VALIDATION_FAILED'));
    expect(await keyOf('p8', 'body')).not.toBe(first);
  });

  it('keeps the key in memory when storage is blocked', async () => {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    const key = await keyOf('p3', 'body', refused('NETWORK'));
    expect(await keyOf('p3', 'edited')).toBe(key);
    expect(() => clearAttempt('p3')).not.toThrow();
  });

  it('keeps the key in memory when storage reads but refuses writes', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    await keyOf('p5', 'older body');
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const newer = await keyOf('p5', 'newer body');
    // Storage still holds the older attempt; the newer one's retry keeps its key.
    expect(await keyOf('p5', 'newer body')).toBe(newer);
  });
});

/** Forgets the module's memory of `product` while keeping what session storage holds. */
function clearMemoryOnly(product: string, storage: ReturnType<typeof memoryStorage>) {
  const saved = storage.getItem(`vd:order-attempt:${product}`);
  clearAttempt(product);
  if (saved) storage.setItem(`vd:order-attempt:${product}`, saved);
}
