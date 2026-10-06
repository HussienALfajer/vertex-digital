import { createDatabase } from '@vertex-digital/db';
import { setup as migrate, testDatabaseUrl } from '@vertex-digital/db/testing';
import { removeLeftovers } from './helpers.js';

/** Migrates the test database, then clears what an interrupted earlier run left behind. */
export async function setup(): Promise<void> {
  await migrate();
  const { db, close } = createDatabase(testDatabaseUrl());
  try {
    await removeLeftovers(db);
  } finally {
    await close();
  }
}
