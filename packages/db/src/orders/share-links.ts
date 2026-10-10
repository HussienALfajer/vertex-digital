import { randomBytes } from 'node:crypto';
import type { ReceiptPlayerDisplay, ShareKind } from '@vertex-digital/contracts';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { orderShareLinks } from '../schema/index.js';

/*
 * Share links (S10 rules GF4, RC1–RC3, SH1): a public, non-guessable token per link. The partial
 * unique index keeps one live link of each kind per order; the guard (migration 0037) keeps the
 * order, kind and token fixed and a revoked link unchanged.
 */

export type ShareLinkRow = typeof orderShareLinks.$inferSelect;

/** 22 base64url characters from 16 CSPRNG bytes (128 bits). */
export function shareToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Inserts a live link; a gift never shows the price and always masks the id. */
export async function createShareLink(
  tx: Transaction,
  input: {
    orderId: string;
    kind: ShareKind;
    showPrice?: boolean;
    playerDisplay?: ReceiptPlayerDisplay;
  },
): Promise<ShareLinkRow> {
  const gift = input.kind === 'gift';
  const [row] = await tx
    .insert(orderShareLinks)
    .values({
      id: newId(),
      orderId: input.orderId,
      kind: input.kind,
      token: shareToken(),
      showPrice: gift ? false : (input.showPrice ?? true),
      playerDisplay: gift ? 'masked' : (input.playerDisplay ?? 'masked'),
    })
    .returning();
  if (!row) throw new Error(`The share link of order ${input.orderId} was not written`);
  return row;
}
