import { afterAll, expect } from 'vitest';
import { concurrentQueries } from './testing.js';

/*
 * Fails a test file that sent a query on a pg client already running one (launch hardening,
 * 2026-10-14): independent reads inside a transaction go through `readAll` (packages/db
 * client.ts), never `Promise.all` on the transaction.
 */
const seen = concurrentQueries();

afterAll(() => {
  expect(seen, 'a query was sent on a pg client already running one: use readAll').toEqual([]);
});
