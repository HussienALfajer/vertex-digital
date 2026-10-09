import { performance } from 'node:perf_hooks';
import type { SupplierCallOperation, SupplierCallResult } from '@vertex-digital/contracts';
import { type Database, newId, supplierCalls, type Transaction } from '@vertex-digital/db';
import { SupplierError } from '@vertex-digital/suppliers';

/*
 * Every adapter call is recorded in `supplier_calls` (S07 rule H1), with its latency and the
 * supplier's error code only: never a message, which may carry player data.
 */

export type RecordedCall<T> =
  | { ok: true; value: T }
  | { ok: false; result: Exclude<SupplierCallResult, 'ok'>; error: unknown };

/** `refused`: the supplier answered with a definitive refusal; anything else is an `error`. */
const resultOf = (error: unknown): Exclude<SupplierCallResult, 'ok'> =>
  error instanceof SupplierError && error.kind === 'definitive' ? 'refused' : 'error';

/**
 * `classify` reads an answer that did not throw (S08: an order's `unknown` outcome is an `error`,
 * a definitive refusal `refused`); by default an answer is `ok`.
 */
export async function recordedCall<T>(
  db: Database | Transaction,
  supplierId: string,
  operation: SupplierCallOperation,
  call: () => Promise<T>,
  classify: (value: T) => SupplierCallResult = () => 'ok',
): Promise<RecordedCall<T>> {
  const started = performance.now();
  let outcome: RecordedCall<T>;
  try {
    outcome = { ok: true, value: await call() };
  } catch (error) {
    outcome = { ok: false, result: resultOf(error), error };
  }
  const supplierCode =
    !outcome.ok && outcome.error instanceof SupplierError
      ? (outcome.error.details.supplierCode?.slice(0, 64) ?? null)
      : null;
  await db.insert(supplierCalls).values({
    id: newId(),
    supplierId,
    operation,
    result: outcome.ok ? classify(outcome.value) : outcome.result,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    supplierCode,
  });
  return outcome;
}

/**
 * An error's message for a sync run, a log or an alert (rule SP2): the credential values masked,
 * query strings dropped from URLs (a key may travel there), at most 500 characters.
 */
export function sanitizedMessage(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret.length >= 4) message = message.replaceAll(secret, '***');
  }
  return message.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 500);
}
