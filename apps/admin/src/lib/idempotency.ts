import { useRef } from 'react';
import { ApiError } from './api/client';

/** Sends `body` with an `Idempotency-Key`, through `request`, and returns its answer. */
export type IdempotentRequest = <Result>(
  body: unknown,
  request: (key: string) => Promise<Result>,
) => Promise<Result>;

/**
 * Whether a failed attempt may still have been written: no answer (the network dropped, the
 * re-authentication was left), a server fault, or the API saying the key already holds another
 * request (`IDEMPOTENCY_KEY_REUSED`: the first one was written).
 */
function mayHaveLanded(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || error.code === 'IDEMPOTENCY_KEY_REUSED';
}

/**
 * The `Idempotency-Key` rule of the panel's money actions (S02 rule J9, S03 rule RV9): one key
 * per dialog opening, kept while the same body is sent again (a retry after re-authentication or
 * a lost answer gets the first result), and a new one once a field changed after a clear refusal,
 * so the edited request is not answered `IDEMPOTENCY_KEY_REUSED`. After an attempt whose outcome
 * is unknown the key stays whatever changes, until an answer comes back: an edited retry of a
 * request that was written is then refused instead of written a second time (audit A1).
 */
export function createIdempotentRequest(newKey: () => string = () => crypto.randomUUID()) {
  let last: { key: string; body: string; unsettled: boolean } | null = null;
  const send: IdempotentRequest = async (body, request) => {
    const sent = JSON.stringify(body);
    if (!last || (!last.unsettled && last.body !== sent)) {
      last = { key: newKey(), body: sent, unsettled: false };
    }
    const attempt = last;
    attempt.body = sent;
    try {
      const result = await request(attempt.key);
      attempt.unsettled = false;
      return result;
    } catch (error) {
      if (mayHaveLanded(error)) attempt.unsettled = true;
      throw error;
    }
  };
  return send;
}

/** `createIdempotentRequest` for one mounted dialog or page. */
export function useIdempotentRequest(): IdempotentRequest {
  const send = useRef<IdempotentRequest | null>(null);
  send.current ??= createIdempotentRequest();
  return send.current;
}
