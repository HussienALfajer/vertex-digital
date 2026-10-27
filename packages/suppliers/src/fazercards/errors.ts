import { SUBSCRIPTION_INACTIVE_CODE } from '../core/adapter.js';
import { errorReplySchema } from './schemas.js';

/** FazerCards' error code from a refused reply's body (`code`, when it gives one). */
export function fzrErrorCode(body: unknown): string | undefined {
  const parsed = errorReplySchema.safeParse(body);
  return parsed.success ? parsed.data.code : undefined;
}

/** A FazerCards refusal reply (`{ ok: false, error }`) that names no `code` of its own. */
export const FZR_REFUSED = 'refused';

/**
 * A category read's code: FazerCards' own, or `refused` for its refusal reply without one, so a
 * 404 in FazerCards' own words (a category it no longer knows) tells apart from a gateway's 404
 * (audit A05-19).
 */
export function fzrCategoryErrorCode(body: unknown): string | undefined {
  const parsed = errorReplySchema.safeParse(body);
  if (!parsed.success) return undefined;
  return (
    parsed.data.code ?? (parsed.data.ok === false && parsed.data.error ? FZR_REFUSED : undefined)
  );
}

/** FC5, FC9: an order on an inactive plan is refused before anything is charged. */
export const FZR_SUBSCRIPTION_INACTIVE = SUBSCRIPTION_INACTIVE_CODE;

/**
 * Order refusals that mean nothing was bought, so the next route may be tried (ADR 0004). FazerCards
 * publishes no list of `code` values (docs/suppliers/fazercards.md, "Errors"): every other refusal
 * stays retryable, so the order is `unknown` and resolved by polling, then the admin, until a funded
 * test maps more.
 */
export const FZR_DEFINITIVE_ORDER_CODES = [FZR_SUBSCRIPTION_INACTIVE];
