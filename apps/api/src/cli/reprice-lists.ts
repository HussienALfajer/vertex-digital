/**
 * S20 RP4: prices every routed product on every price list after the S20 deploy, and again
 * whenever a list's rows must be caught up. Idempotent: `repriceProducts` writes only missing or
 * changed rows, and retail moves only as any repricing moves it (a cost change beyond the
 * threshold opens a review instead). One transaction per batch of products.
 *
 *   pnpm --filter @vertex-digital/api pricing:reprice-lists
 */
import { createDatabase, loadRootEnv, repriceProducts, routedProducts } from '@vertex-digital/db';
import { parseEnv } from '../core/config/env.js';
import { routingContext } from '../core/config/routing-context.js';

loadRootEnv();

/** Products per transaction: the locks of one batch are held only while it is priced. */
const BATCH = 100;

const env = parseEnv();
const { db, close } = createDatabase(env.DATABASE_URL);
try {
  const productIds = await db.transaction((tx) => routedProducts(tx));
  const totals = { products: productIds.length, retail: 0, lists: 0, reviews: 0 };
  for (let start = 0; start < productIds.length; start += BATCH) {
    const result = await db.transaction((tx) =>
      repriceProducts(tx, {
        productIds: productIds.slice(start, start + BATCH),
        cause: 'list_change',
        context: routingContext(env),
      }),
    );
    totals.retail += result.repriced;
    totals.lists += result.listRowsAppended;
    totals.reviews += result.reviewsOpened;
  }
  process.stdout.write(
    `Priced ${totals.products} products: ${totals.lists} list rows and ${totals.retail} retail rows written, ${totals.reviews} reviews opened.\n`,
  );
} finally {
  await close();
}
