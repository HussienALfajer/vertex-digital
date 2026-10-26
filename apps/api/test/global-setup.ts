import { createDatabase } from '@vertex-digital/db';
import {
  createMissingDatabases,
  holdTestDatabases,
  prepareTestDatabase,
  workerDatabases,
} from '@vertex-digital/db/testing';
import { removeLeftovers } from './helpers.js';

/**
 * Holds the suite's worker databases for the run (one per Vitest worker, packages/db testing.ts),
 * so a second run waits for this one; creates the missing ones and migrates them, then clears what
 * an interrupted earlier run left behind in each. Returns the teardown that releases them.
 */
export async function setup(): Promise<() => Promise<void>> {
  const release = await holdTestDatabases('api');
  try {
    const databases = workerDatabases('api');
    await createMissingDatabases(databases);
    await Promise.all(
      databases.map(async ({ url, ownerUrl }) => {
        await prepareTestDatabase(ownerUrl, url);
        const { db, close } = createDatabase(url);
        try {
          await removeLeftovers(db);
        } finally {
          await close();
        }
      }),
    );
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
