/**
 * S23 PX1: the one-off merchant tier setup, run once in production after the S23 deploy (and by
 * `db:seed-local`): renames the wholesale list "البرونزية", creates the chained tier lists "الفضية",
 * "الذهبية" and "الماسية" with their global and category rules, and the Silver, Gold and Diamond
 * levels at $300, $1,000 and $3,000 on them; then prices every routed product on every list and
 * queues every merchant's recomputation (the worker moves them). Idempotent: what exists by name
 * or tier is left as it is and reported.
 *
 *   pnpm --filter @vertex-digital/api merchants:setup-tiers
 */
import { createDatabase, loadRootEnv, setupMerchantTiers } from '@vertex-digital/db';
import { parseEnv } from '../core/config/env.js';
import { routingContext } from '../core/config/routing-context.js';
import { JobsService } from '../core/jobs/index.js';

loadRootEnv();

const env = parseEnv();
const { db, close } = createDatabase(env.DATABASE_URL);
const jobs = new JobsService(env);
try {
  const report = await setupMerchantTiers(db, { jobs, routing: routingContext(env) });
  for (const line of report.lines) process.stdout.write(`${line}\n`);
  process.stdout.write(
    `Wrote ${report.listRowsAppended} list rows; queued ${report.merchantsQueued} merchants' recomputations.\n`,
  );
} finally {
  await jobs.onApplicationShutdown();
  await close();
}
