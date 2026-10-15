import { createDatabase } from '@vertex-digital/db';
import { prepareTestDatabase, workerDatabases } from '@vertex-digital/db/testing';
import { removeLeftovers } from './helpers.js';

/**
 * Migrates every worker's test database (one per Vitest worker, packages/db testing.ts), then
 * clears what an interrupted earlier run left behind in it.
 */
export async function setup(): Promise<void> {
  await Promise.all(
    workerDatabases('api').map(async ({ url, ownerUrl }) => {
      await prepareTestDatabase(ownerUrl, url);
      const { db, close } = createDatabase(url);
      try {
        await removeLeftovers(db);
      } finally {
        await close();
      }
    }),
  );
}
