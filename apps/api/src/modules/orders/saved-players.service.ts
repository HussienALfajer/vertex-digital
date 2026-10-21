import { Inject, Injectable } from '@nestjs/common';
import type {
  SavedPlayer,
  SavedPlayerList,
  SavedPlayerListQuery,
  UpdateSavedPlayer,
} from '@vertex-digital/contracts';
import { customerSavedPlayers, type Database, savedPlayers } from '@vertex-digital/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { orderRefusals } from './order-errors.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/**
 * "معرّفاتي" (S10 F14, rule SP5): the customer's own saved ids, listed, renamed and deleted for
 * real. Saving happens inside a purchase (`packages/db`). Not audited: the customer's preferences,
 * not money or admin actions. Another customer's id is not found.
 */
@Injectable()
export class SavedPlayersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(customerId: string, query: SavedPlayerListQuery): Promise<SavedPlayerList> {
    return {
      items: await customerSavedPlayers(this.db, customerId, {
        ...(query.gameId && { gameId: query.gameId }),
      }),
    };
  }

  async view(customerId: string, id: string): Promise<SavedPlayer> {
    const [saved] = await customerSavedPlayers(this.db, customerId, { id });
    if (!saved) throw orderRefusals.notFound();
    return saved;
  }

  /** SP5 the label, S22 QB5 the quick-buy switch. */
  async update(customerId: string, id: string, input: UpdateSavedPlayer): Promise<SavedPlayer> {
    if (!isUuid(id)) throw orderRefusals.notFound();
    const [row] = await this.db
      .update(savedPlayers)
      .set({
        ...(input.label !== undefined && { label: input.label }),
        ...(input.quickBuyHidden !== undefined && { quickBuyHidden: input.quickBuyHidden }),
      })
      .where(and(eq(savedPlayers.id, id), eq(savedPlayers.customerId, customerId)))
      .returning({ id: savedPlayers.id });
    if (!row) throw orderRefusals.notFound();
    return this.view(customerId, id);
  }

  async remove(customerId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw orderRefusals.notFound();
    const [row] = await this.db
      .delete(savedPlayers)
      .where(and(eq(savedPlayers.id, id), eq(savedPlayers.customerId, customerId)))
      .returning({ id: savedPlayers.id });
    if (!row) throw orderRefusals.notFound();
  }
}
