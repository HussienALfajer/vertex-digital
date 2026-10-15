import { afterAll, expect } from 'vitest';
import { poolReadsInTransactions } from './testing.js';

/*
 * Fails a test file that sent a query through the pool while a transaction of the same flow held
 * a connection (F3-4): the write paths here read through the transaction they are given.
 */
const seen = poolReadsInTransactions();

afterAll(() => {
  expect(seen, 'a pool read inside a transaction: pass the transaction instead').toEqual([]);
});
