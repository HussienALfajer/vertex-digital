import { QUEUES, STORE_REVALIDATE_THROTTLE_SECONDS } from '@vertex-digital/contracts';
import type { Transaction } from '../client.js';
import type { JobSender } from '../notifications/index.js';

/**
 * S09 rule SF4: the store's cached catalog pages are refreshed after a change to what they show
 * (catalog, prices, availability, health, a supplier pause, the rate). One job per 10-second
 * slot, whatever number of changes queue it; the worker calls the store's revalidate route.
 */
export async function queueStoreRevalidate(tx: Transaction, jobs: JobSender): Promise<void> {
  await jobs.send(
    tx,
    QUEUES.storeRevalidate,
    {},
    {
      singletonKey: 'catalog',
      singletonSeconds: STORE_REVALIDATE_THROTTLE_SECONDS,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
    },
  );
}
