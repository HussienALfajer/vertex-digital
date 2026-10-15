import { prepareTestDatabase, workerDatabases } from '@vertex-digital/db/testing';

/** Migrates every worker's test database (and installs pg-boss) as the owner before any test runs. */
export async function setup(): Promise<void> {
  await Promise.all(
    workerDatabases('worker').map(({ url, ownerUrl }) => prepareTestDatabase(ownerUrl, url)),
  );
}
