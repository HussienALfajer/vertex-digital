import { poolReadsInTransactions } from '@vertex-digital/db/testing';
import { afterAll, expect } from 'vitest';

/*
 * Fails a test file that sent a query through the pool while a transaction of the same flow held
 * a connection (F3-4): a read inside a transaction goes through the transaction, never `this.db`
 * or a service method that reads it.
 */
const seen = poolReadsInTransactions();

afterAll(() => {
  expect(seen, 'a pool read inside a transaction: pass the transaction instead').toEqual([]);
});
