import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import type {
  FailureKind,
  SupplierCallOperation,
  SupplierCallResult,
} from '@vertex-digital/contracts';
import { type Database, newId, supplierCalls, type Transaction } from '@vertex-digital/db';
import { SUBSCRIPTION_INACTIVE_CODE, SupplierError } from '@vertex-digital/suppliers';

/*
 * Every adapter call is recorded in `supplier_calls` (S07 rule H1), with its latency and the
 * supplier's error code only: never a message, which may carry player data. S18 FK1, FK2: an
 * `error` call also keeps why (its failure kind and HTTP status) and is logged at `warn`.
 */

const logger = new Logger('SupplierCalls');

/** How an answer that did not throw counts (S08, S18 HE4, HE6). */
export interface CallVerdict {
  result: SupplierCallResult;
  supplierCode?: string;
  failure?: FailureKind;
  httpStatus?: number;
}

export type RecordedCall<T> =
  | { ok: true; value: T }
  | { ok: false; result: Exclude<SupplierCallResult, 'ok'>; error: unknown };

/**
 * `refused`: the supplier answered with a definitive refusal, or refused for an inactive plan (S19
 * FC9: an answer, so the supplier is not down while its plan lapses, audit A05-15); anything else
 * is an `error`.
 */
const resultOf = (error: unknown): Exclude<SupplierCallResult, 'ok'> =>
  error instanceof SupplierError &&
  (error.kind === 'definitive' || error.details.supplierCode === SUBSCRIPTION_INACTIVE_CODE)
    ? 'refused'
    : 'error';

/** What a thrown error says of the call (S18 FK1): a non-`SupplierError` is `other`. */
function verdictOf(error: unknown): CallVerdict {
  const result = resultOf(error);
  if (!(error instanceof SupplierError)) return { result, failure: 'other' };
  const { supplierCode, failure, status } = error.details;
  return {
    result,
    ...(supplierCode !== undefined && { supplierCode }),
    ...(result === 'error' && { failure: failure ?? 'other' }),
    ...(status !== undefined && { httpStatus: status }),
  };
}

/**
 * `classify` reads an answer that did not throw (S08: an order's `unknown` outcome is an `error`,
 * a definitive refusal `refused`; S18 HE4: an answer the supplier gave that does not settle the
 * order yet is `ok`); by default an answer is `ok`.
 */
export async function recordedCall<T>(
  db: Database | Transaction,
  supplierId: string,
  operation: SupplierCallOperation,
  call: () => Promise<T>,
  classify: (value: T) => SupplierCallResult | CallVerdict = () => 'ok',
): Promise<RecordedCall<T>> {
  const started = performance.now();
  let outcome: RecordedCall<T>;
  try {
    outcome = { ok: true, value: await call() };
  } catch (error) {
    outcome = { ok: false, result: resultOf(error), error };
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  const classified = outcome.ok ? classify(outcome.value) : verdictOf(outcome.error);
  const verdict: CallVerdict = typeof classified === 'string' ? { result: classified } : classified;
  const failure = verdict.result === 'error' ? (verdict.failure ?? 'other') : null;
  const httpStatus =
    verdict.httpStatus !== undefined && verdict.httpStatus >= 100 && verdict.httpStatus <= 599
      ? verdict.httpStatus
      : null;
  const supplierCode = verdict.supplierCode?.slice(0, 64) ?? null;
  await db.insert(supplierCalls).values({
    id: newId(),
    supplierId,
    operation,
    result: verdict.result,
    latencyMs,
    supplierCode,
    failureKind: failure,
    httpStatus,
  });
  if (failure !== null) {
    logger.warn(
      `Supplier call failed: supplier ${supplierId}, ${operation}, ${failure}` +
        `${httpStatus !== null ? `, HTTP ${httpStatus}` : ''}` +
        `${supplierCode !== null ? `, ${supplierCode}` : ''}, ${latencyMs} ms`,
    );
  }
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
