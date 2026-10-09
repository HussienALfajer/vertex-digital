import { createHash } from 'node:crypto';
import {
  canonicalFields,
  type PlayerCheckState,
  SAVED_PLAYERS_MAX,
  SAVED_PLAYERS_PER_GAME,
} from '@vertex-digital/contracts';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { savedPlayers } from '../schema/index.js';

/*
 * Saved player ids (S10 F14, rules SP1, SP2, SP4, SP6), written in the transaction of the order
 * that uses them. The caller holds the customer's wallet lock, so the limits are counted while
 * no other purchase of this customer can save at the same time.
 */

export type SavedPlayerRow = typeof savedPlayers.$inferSelect;

/** SHA-256 of the game id and the canonical fields: one saved row per id per game. */
export function savedPlayerHash(gameId: string, fields: Record<string, string>): string {
  return createHash('sha256')
    .update(JSON.stringify([gameId, canonicalFields(fields)]))
    .digest('hex');
}

/** The customer's saved row for these fields, if any. */
export async function findSavedPlayer(
  tx: Transaction,
  customerId: string,
  gameId: string,
  fields: Record<string, string>,
): Promise<SavedPlayerRow | null> {
  const [row] = await tx
    .select()
    .from(savedPlayers)
    .where(
      and(
        eq(savedPlayers.customerId, customerId),
        eq(savedPlayers.gameId, gameId),
        eq(savedPlayers.fieldsHash, savedPlayerHash(gameId, fields)),
      ),
    );
  return row ?? null;
}

/**
 * Rules SP1, SP2 and SP4 for one order: the matching saved row gets `last_used_at` (and the name
 * of a `valid` check); with `save`, a missing row is inserted with the label when the customer is
 * under both limits, else nothing is saved. Answers the saved row when `save` was asked and the
 * row exists now; null otherwise.
 */
export async function touchSavedPlayer(
  tx: Transaction,
  order: {
    customerId: string;
    gameId: string;
    fields: Record<string, string>;
    playerCheck: PlayerCheckState;
    playerName: string | null;
  },
  save: { label: string } | null,
): Promise<SavedPlayerRow | null> {
  const named = order.playerCheck === 'valid' && order.playerName !== null;
  const name = named ? { playerName: order.playerName, nameCheckedAt: sql`now()` } : {};
  const hash = savedPlayerHash(order.gameId, order.fields);
  const [touched] = await tx
    .update(savedPlayers)
    .set({ lastUsedAt: sql`now()`, ...name })
    .where(
      and(
        eq(savedPlayers.customerId, order.customerId),
        eq(savedPlayers.gameId, order.gameId),
        eq(savedPlayers.fieldsHash, hash),
      ),
    )
    .returning();
  if (touched || !save) return save ? (touched ?? null) : null;

  const [counts] = await tx
    .select({
      all: count(),
      game: sql<number>`count(*) filter (where ${savedPlayers.gameId} = ${order.gameId})`.mapWith(
        Number,
      ),
    })
    .from(savedPlayers)
    .where(eq(savedPlayers.customerId, order.customerId));
  if ((counts?.all ?? 0) >= SAVED_PLAYERS_MAX || (counts?.game ?? 0) >= SAVED_PLAYERS_PER_GAME) {
    return null;
  }
  const [inserted] = await tx
    .insert(savedPlayers)
    .values({
      id: newId(),
      customerId: order.customerId,
      gameId: order.gameId,
      label: save.label,
      fields: order.fields,
      fieldsHash: hash,
      lastUsedAt: sql`now()`,
      ...name,
    })
    .returning();
  return inserted ?? null;
}

/**
 * Rule SP6 at an order's terminal status: a refund for `input_rejected` marks the customer's
 * matching saved rows rejected; a delivery clears the mark.
 */
export async function markSavedPlayers(
  tx: Transaction,
  order: { customerId: string; gameId: string; fields: Record<string, string> },
  rejected: boolean,
): Promise<void> {
  await tx
    .update(savedPlayers)
    .set({ rejectedAt: rejected ? sql`now()` : null })
    .where(
      and(
        eq(savedPlayers.customerId, order.customerId),
        eq(savedPlayers.gameId, order.gameId),
        eq(savedPlayers.fieldsHash, savedPlayerHash(order.gameId, order.fields)),
      ),
    );
}
