import { shopCacheTag } from '@vertex-digital/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import type { JobSender } from '../notifications/index.js';
import { merchantShops } from '../schema/index.js';
import { queueStoreRevalidate } from '../store/revalidate.js';

/**
 * S26: refresh the store's cached pages of a merchant's shop (`shop:<id>`) in the transaction of
 * a change they show: the shop's settings, hidden games, state, and the merchant's selling
 * prices. Nothing without a shop whose pages answer (active, suspended or closed).
 */
export async function queueShopRevalidate(
  tx: Transaction,
  jobs: JobSender,
  merchantId: string,
): Promise<void> {
  const shops = await tx
    .select({ id: merchantShops.id })
    .from(merchantShops)
    .where(
      and(
        eq(merchantShops.merchantId, merchantId),
        inArray(merchantShops.status, ['active', 'suspended', 'closed']),
      ),
    );
  for (const shop of shops) await queueStoreRevalidate(tx, jobs, shopCacheTag(shop.id));
}
