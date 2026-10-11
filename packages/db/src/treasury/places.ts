import {
  floorToWholeCents,
  type MoneyPlaces,
  supplierOfPlace,
  TREASURY_ACCOUNTS,
  TREASURY_PLACES,
  type TreasuryPlace,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { openingRecorded, placeBooks } from '../reconciliation/external.js';
import { units } from '../reconciliation/types.js';

/*
 * The money places view (S13 screens, rules T1, T6, LS2): each place with what the books say it
 * holds, the newest balance seen outside the books and the opening amount to propose. A shared
 * read: it joins the suppliers' balance reads and the reconciliation's results.
 */

type Executor = Database | Transaction;
type External = NonNullable<MoneyPlaces['places'][number]['external']>;

/** The newest outside balance of a place: a supplier read, a chain read or a count; null for none. */
async function externalBalance(db: Executor, place: TreasuryPlace): Promise<External | null> {
  const supplier = supplierOfPlace(place);
  if (supplier === 'manual' || place.startsWith('outside_')) return null;
  if (supplier !== null) {
    const { rows } = await db.execute<{ units: string; at: string }>(sql`
      select r.amount_units::text as units, r.created_at::text as at
      from supplier_balance_reads r join suppliers s on s.id = r.supplier_id
      where s.code = ${supplier} and r.currency = 'USD'
      order by r.created_at desc limit 1`);
    const row = rows[0];
    return row
      ? { units: units(row.units), at: new Date(row.at).toISOString(), source: 'supplier' }
      : null;
  }
  const check = place.startsWith('usdt_') ? 'usdt_balance' : 'sham_cash_count';
  const { rows } = await db.execute<{ units: string; at: string }>(sql`
    select actual_units::text as units, created_at::text as at from reconciliation_results
    where "check" = ${check} and subject = ${place} and actual_units is not null
    order by created_at desc limit 1`);
  const row = rows[0];
  if (!row) return null;
  return {
    units: units(row.units),
    at: new Date(row.at).toISOString(),
    source: check === 'usdt_balance' ? 'chain' : 'count',
  };
}

/**
 * Rule T6: the opening that makes the books match the outside balance now, or null when an opening
 * stands, nothing outside is known or the books already hold as much. USD places other than a
 * supplier take whole cents (rule T3), so the amount is floored.
 */
function proposedOpening(
  place: TreasuryPlace,
  books: number,
  external: External | null,
  recorded: boolean,
): number | null {
  if (recorded || external === null || external.units <= books) return null;
  const amount = external.units - books;
  const wholeCents = TREASURY_ACCOUNTS[place].currency === 'USD' && supplierOfPlace(place) === null;
  const proposed = wholeCents ? floorToWholeCents(amount) : amount;
  return proposed > 0 ? proposed : null;
}

/** `GET /api/admin/treasury/places`. */
export async function moneyPlaces(db: Executor): Promise<MoneyPlaces> {
  const places = await Promise.all(
    TREASURY_PLACES.map(async (place) => {
      const [booksUnits, external, recorded] = await Promise.all([
        placeBooks(db, place),
        externalBalance(db, place),
        openingRecorded(db, place),
      ]);
      return {
        place,
        currency: TREASURY_ACCOUNTS[place].currency,
        booksUnits,
        external,
        differenceUnits: external === null ? null : external.units - booksUnits,
        openingRecorded: recorded,
        proposedOpeningUnits: proposedOpening(place, booksUnits, external, recorded),
      };
    }),
  );
  return { places };
}
