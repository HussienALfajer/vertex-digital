import {
  createMissingDatabases,
  holdTestDatabases,
  prepareTestDatabase,
  workerDatabases,
} from '@vertex-digital/db/testing';

/**
 * Holds the suite's worker databases for the run, so a second run waits for this one; creates the
 * missing ones, then migrates each (and installs pg-boss) as the owner before any test runs.
 * Returns the teardown that releases them.
 */
export async function setup(): Promise<() => Promise<void>> {
  const release = await holdTestDatabases('worker');
  try {
    const databases = workerDatabases('worker');
    await createMissingDatabases(databases);
    await Promise.all(databases.map(({ url, ownerUrl }) => prepareTestDatabase(ownerUrl, url)));
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
