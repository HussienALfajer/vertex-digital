import { Inject, Injectable } from '@nestjs/common';
import { type QuickBuy, type QuickBuyState, sypDisplayPrice } from '@vertex-digital/contracts';
import {
  accountPriceList,
  type Database,
  productRoutingStates,
  quickBuyRows,
} from '@vertex-digital/db';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { RatesService } from '../rates/index.js';

/**
 * "اشحن مجدداً" (S22 QB1–QB3): the customer's saved IDs with the pack of their latest paid
 * order, at today's unit price on the customer's effective list (S20, S21 LV5). Read only: the
 * purchase is S08's `POST /api/orders` with the slide.
 */
@Injectable()
export class QuickBuyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly rates: RatesService,
  ) {}

  async cards(customerId: string): Promise<QuickBuy> {
    const [rows, pricing, rate] = await Promise.all([
      quickBuyRows(this.db, customerId),
      accountPriceList(this.db, customerId),
      this.rates.current(),
    ]);
    if (rows.length === 0 || !pricing) return { items: [] };
    const states = await productRoutingStates(
      this.db,
      [...new Set(rows.map((row) => row.product.id))],
      routingContext(this.env),
      pricing.effectiveList.id,
    );
    return {
      items: rows.map(({ savedPlayer, product, quantity }) => {
        const routing = states.get(product.id);
        const price =
          product.live && routing?.availability === 'available'
            ? (routing.current?.priceUsdUnits ?? null)
            : null;
        const state: QuickBuyState =
          price === null
            ? 'unavailable'
            : savedPlayer.rejected
              ? 'rejected'
              : savedPlayer.complete
                ? 'ready'
                : 'incomplete';
        return {
          savedPlayer,
          game: {
            slug: savedPlayer.gameSlug,
            nameAr: savedPlayer.gameNameAr,
            cover: savedPlayer.cover,
          },
          product: {
            id: product.id,
            nameAr: product.nameAr,
            kind: product.kind,
            gameAmount: product.gameAmount,
          },
          quantity,
          unitPriceUsdUnits: price,
          unitPriceSypUnits:
            price !== null && rate
              ? sypDisplayPrice(price, rate.sypPerUsd, rate.displayStepSypUnits)
              : null,
          priceKind: pricing.priceKind,
          state,
        };
      }),
    };
  }
}
