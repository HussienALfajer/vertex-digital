import { useRef } from 'react';

/**
 * The `Idempotency-Key` for a request body (S02 rule J9, S03 rule RV9): one per dialog opening,
 * kept while the same body is sent again (a retry after re-authentication or a lost answer gets
 * the first result), and a new one once a field changed after a refusal, so the edited request is
 * not answered `IDEMPOTENCY_KEY_REUSED`.
 */
export function useIdempotencyKey(): (body: unknown) => string {
  const last = useRef<{ key: string; body: string } | null>(null);
  return (body) => {
    const sent = JSON.stringify(body);
    if (last.current?.body !== sent) last.current = { key: crypto.randomUUID(), body: sent };
    return last.current.key;
  };
}
