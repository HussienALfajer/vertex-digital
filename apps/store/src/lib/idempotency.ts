import { useRef } from 'react';
import type { Failure, Result } from './api';

/** An `Idempotency-Key` and the body it was last sent with. */
export type Attempt = { key: string; body: string; unsettled: boolean };

/**
 * Whether a refused attempt may still have been written: no answer (`NETWORK`), a server fault
 * (the API answers every 5xx `INTERNAL_ERROR`; a proxy's 502 or 504 has no code, `UNKNOWN`), or
 * the API saying the key already holds another request (`IDEMPOTENCY_KEY_REUSED`: the first one
 * was written).
 */
export function mayHaveLanded(reason: Failure): boolean {
  return (
    reason === 'NETWORK' ||
    reason === 'UNKNOWN' ||
    reason === 'INTERNAL_ERROR' ||
    reason === 'IDEMPOTENCY_KEY_REUSED'
  );
}

/**
 * The attempt to send `body` with: the last one's key while the body is the same, or whatever the
 * body once an attempt's outcome is unknown (an edited retry of a request that was written is then
 * refused `IDEMPOTENCY_KEY_REUSED` instead of written a second time, F6-14); a new key only when
 * the body changed after a clear answer.
 */
export function attemptFor(
  last: Attempt | null,
  body: string,
  newKey: () => string = () => crypto.randomUUID(),
): Attempt {
  if (!last || (!last.unsettled && last.body !== body)) {
    return { key: newKey(), body, unsettled: false };
  }
  return { ...last, body };
}

/**
 * The attempt after its answer: none after a success (the next body is a new request), marked
 * unsettled after an answer that may follow a write, unchanged after a clear refusal (a refusal
 * answered before the key is looked up, a rate limit or a lost session, says nothing of an
 * earlier attempt).
 */
export function afterAnswer(attempt: Attempt, result: Result<unknown>): Attempt | null {
  if (result.ok) return null;
  return mayHaveLanded(result.reason) ? { ...attempt, unsettled: true } : attempt;
}

/** Sends `body` (as serialized) with an `Idempotency-Key`, through `request`. */
export type IdempotentRequest = <Data>(
  body: string,
  request: (key: string) => Promise<Result<Data>>,
) => Promise<Result<Data>>;

/** `attemptFor` and `afterAnswer` around each request, the attempt kept in memory. */
export function createIdempotentRequest(newKey?: () => string): IdempotentRequest {
  let last: Attempt | null = null;
  return async (body, request) => {
    const attempt = attemptFor(last, body, newKey);
    last = attempt;
    const result = await request(attempt.key);
    last = afterAnswer(attempt, result);
    return result;
  };
}

/** `createIdempotentRequest` for one mounted form (a deposit, a ticket, a reply). */
export function useIdempotentRequest(): IdempotentRequest {
  const send = useRef<IdempotentRequest | null>(null);
  send.current ??= createIdempotentRequest();
  return send.current;
}
