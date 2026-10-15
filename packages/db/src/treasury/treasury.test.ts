import {
  CURRENCY_SCALE,
  TREASURY_ACCOUNTS,
  type TreasuryEndpoint,
} from '@vertex-digital/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Transaction } from '../client.js';
import { newId } from '../id.js';
import { ensureSystemAccount } from '../ledger/index.js';
import { auditEntries, treasuryMovements } from '../schema/index.js';
import { type MovementInput, recordMovement, reverseMovement, TreasuryError } from './movements.js';
import { moneyPlaces } from './places.js';

/*
 * Treasury movements (S13 rules T2–T10, M1–M5). Places are shared accounts, so most tests run in a
 * transaction that is rolled back; the parallel tests commit, then reverse what they wrote: a
 * movement and its reversal leave the place as if neither happened (rule T6, edge case 12).
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db } = connection;

afterAll(() => Promise.all([connection.close(), owner.close()]));

const USD = CURRENCY_SCALE.USD;
const actor = { adminId: newId(), ipAddress: '203.0.113.9', userAgent: 'Test' };

class Rollback extends Error {}

/** Runs `work` in a transaction that is always rolled back; its result is returned. */
async function rolledBack<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db
    .transaction(async (tx) => {
      result = await work(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result as T;
}

function transfer(
  from: TreasuryEndpoint,
  to: TreasuryEndpoint,
  overrides: Partial<MovementInput> = {},
): MovementInput {
  return {
    idempotencyKey: newId(),
    kind: 'transfer',
    from,
    to,
    sentUnits: 20 * USD,
    receivedUnits: 20 * USD,
    outsideCategory: from.startsWith('outside') || to.startsWith('outside') ? 'owner' : null,
    openingBalance: false,
    orderId: null,
    externalReference: null,
    reason: 'A test movement',
    ...overrides,
  };
}

async function postings(tx: Transaction, journalId: string): Promise<[string, number][]> {
  const { rows } = await tx.execute<{ code: string; amount: string }>(sql`
    select a.code, p.amount_units::text as amount from ledger_postings p
    join ledger_accounts a on a.id = p.account_id
    where p.journal_id = ${journalId} order by p.position`);
  return rows.map((row) => [row.code, Number(row.amount)]);
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof TreasuryError ? error.code : error),
  );

describe('recording movements', () => {
  it('posts a same-currency transfer with its fee, its row and its audit entry (rule M1)', async () => {
    await rolledBack(async (tx) => {
      const { movement, created } = await recordMovement(
        tx,
        transfer('usdt_trc20', 'supplier:wdgzone', {
          sentUnits: 500 * USD,
          receivedUnits: 499 * USD,
          externalReference: 'ab12cd',
        }),
        actor,
      );
      expect(created).toBe(true);
      expect(movement).toMatchObject({ rate: null, sentCurrency: 'USD', openingBalance: false });
      expect(await postings(tx, movement.journalId)).toEqual([
        ['usdt_receipts:usdt_trc20', 500 * USD],
        ['supplier_prepaid:wdgzone', -499 * USD],
        ['transfer_fees:USD', -1 * USD],
      ]);
      const [entry] = await tx
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.entityId, movement.id));
      expect(entry).toMatchObject({
        action: 'treasury_movement.created',
        actorId: actor.adminId,
        reason: 'A test movement',
        details: expect.objectContaining({
          from: 'usdt_trc20',
          to: 'supplier:wdgzone',
          externalReference: 'ab12cd',
        }),
      });
    });
  });

  it('posts two currencies through the exchange and stores the implied rate (rule M2)', async () => {
    await rolledBack(async (tx) => {
      const { movement } = await recordMovement(
        tx,
        transfer('sham_cash_syp', 'usdt_bep20', {
          sentUnits: 1_305_000_00,
          receivedUnits: 100 * USD,
        }),
        actor,
      );
      expect(movement.rate).toBe('13050.0000');
      expect(await postings(tx, movement.journalId)).toEqual([
        ['sham_cash_receipts:SYP', 1_305_000_00],
        ['currency_exchange:SYP', -1_305_000_00],
        ['currency_exchange:USD', 100 * USD],
        ['usdt_receipts:usdt_bep20', -100 * USD],
      ]);
    });
  });

  it('posts a supplier correction against the corrections account (rules T5, M3)', async () => {
    await rolledBack(async (tx) => {
      const { movement } = await recordMovement(
        tx,
        transfer('supplier:fake', 'supplier_corrections', {
          kind: 'supplier_correction',
          sentUnits: 1_250,
          receivedUnits: 1_250,
          outsideCategory: null,
        }),
        actor,
      );
      expect(await postings(tx, movement.journalId)).toEqual([
        ['supplier_prepaid:fake', 1_250],
        ['supplier_corrections:USD', -1_250],
      ]);
    });
  });

  it('replays a key and refuses it for another request', async () => {
    await rolledBack(async (tx) => {
      const input = transfer('outside_usd', 'sham_cash_usd');
      const first = await recordMovement(tx, input, actor);
      const again = await recordMovement(tx, input, actor);
      expect(again).toEqual({ movement: first.movement, created: false });
      expect(
        await refusal(
          recordMovement(tx, { ...input, sentUnits: 21 * USD, receivedUnits: 21 * USD }, actor),
        ),
      ).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  it('books an outgoing reference once per source place, in any case (rule T8)', async () => {
    await rolledBack(async (tx) => {
      const reference = `tx-${newId()}`;
      await recordMovement(
        tx,
        transfer('usdt_trc20', 'outside_usd', { externalReference: reference }),
        actor,
      );
      expect(
        await refusal(
          recordMovement(
            tx,
            transfer('usdt_trc20', 'supplier:fake', { externalReference: reference.toUpperCase() }),
            actor,
          ),
        ),
      ).toBe('EXTERNAL_REFERENCE_TAKEN');
      // Another source place may carry the same reference.
      await recordMovement(
        tx,
        transfer('usdt_bep20', 'supplier:fake', { externalReference: reference }),
        actor,
      );
    });
  });

  it('allows an opening only as the place stands empty, again once it is reversed (T6, edge 12)', async () => {
    await rolledBack(async (tx) => {
      const opening = (overrides: Partial<MovementInput> = {}) =>
        transfer('outside_usd', 'supplier:manual', { openingBalance: true, ...overrides });
      const { movement } = await recordMovement(tx, opening(), actor);
      expect(await refusal(recordMovement(tx, opening(), actor))).toBe('OPENING_BALANCE_EXISTS');
      await reverseMovement(
        tx,
        { movementId: movement.id, idempotencyKey: newId(), reason: 'Wrong amount' },
        actor,
      );
      const second = await recordMovement(
        tx,
        opening({ sentUnits: 30 * USD, receivedUnits: 30 * USD }),
        actor,
      );
      expect(second.created).toBe(true);
      // A later movement into the place makes a new opening impossible.
      await recordMovement(tx, transfer('usdt_trc20', 'supplier:manual'), actor);
      await reverseMovement(
        tx,
        { movementId: second.movement.id, idempotencyKey: newId(), reason: 'Reset' },
        actor,
      );
      expect(await refusal(recordMovement(tx, opening(), actor))).toBe('OPENING_BALANCE_EXISTS');
    });
  });

  it('reverses once with mirrored postings, never a reversal (rules T9, M4)', async () => {
    await rolledBack(async (tx) => {
      const { movement } = await recordMovement(
        tx,
        transfer('usdt_trc20', 'supplier:fake', { sentUnits: 20 * USD, receivedUnits: 19 * USD }),
        actor,
      );
      const key = newId();
      const { movement: reversal } = await reverseMovement(
        tx,
        { movementId: movement.id, idempotencyKey: key, reason: 'Booked by mistake' },
        actor,
      );
      expect(reversal).toMatchObject({
        reversesMovementId: movement.id,
        sentUnits: 20 * USD,
        receivedUnits: 19 * USD,
        externalReference: null,
      });
      expect(await postings(tx, reversal.journalId)).toEqual([
        ['usdt_receipts:usdt_trc20', -20 * USD],
        ['supplier_prepaid:fake', 19 * USD],
        ['transfer_fees:USD', 1 * USD],
      ]);
      expect(
        (
          await reverseMovement(
            tx,
            { movementId: movement.id, idempotencyKey: key, reason: 'Booked by mistake' },
            actor,
          )
        ).created,
      ).toBe(false);
      const again = { idempotencyKey: newId(), reason: 'Again please' };
      expect(await refusal(reverseMovement(tx, { movementId: movement.id, ...again }, actor))).toBe(
        'MOVEMENT_ALREADY_REVERSED',
      );
      expect(await refusal(reverseMovement(tx, { movementId: reversal.id, ...again }, actor))).toBe(
        'MOVEMENT_NOT_REVERSIBLE',
      );
      expect(await refusal(reverseMovement(tx, { movementId: newId(), ...again }, actor))).toBe(
        'NOT_FOUND',
      );
      const [entry] = await tx
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.entityId, reversal.id));
      expect(entry).toMatchObject({
        action: 'treasury_movement.reversed',
        details: expect.objectContaining({ reversedMovementId: movement.id }),
      });
    });
  });

  it('shows each place with its books and proposes an opening (rules LS2, T6)', async () => {
    const before = await committedBooks();
    await rolledBack(async (tx) => {
      await recordMovement(
        tx,
        transfer('outside_usd', 'supplier:wdgzone', {
          sentUnits: 50 * USD,
          receivedUnits: 50 * USD,
        }),
        actor,
      );
      const { places } = await moneyPlaces(tx);
      expect(places.map((place) => place.place)).toContain('sham_cash_syp');
      const wdgzone = places.find((place) => place.place === 'supplier:wdgzone');
      const outside = places.find((place) => place.place === 'outside_usd');
      expect(wdgzone?.currency).toBe('USD');
      // The movement adds 50 to what the supplier holds and to what came from outside.
      expect(wdgzone?.booksUnits).toBe((before.get('supplier:wdgzone') ?? 0) + 50 * USD);
      expect(outside?.booksUnits).toBe((before.get('outside_usd') ?? 0) + 50 * USD);
      expect(places.find((place) => place.place === 'supplier:manual')?.external).toBeNull();
    });
  });
});

/** The committed books of each place, read before the test's transaction (F3-4: never inside it). */
async function committedBooks(): Promise<Map<string, number>> {
  const { places } = await moneyPlaces(db);
  return new Map(places.map((place) => [place.place, place.booksUnits]));
}

describe('movements in parallel', () => {
  // A run stopped halfway may have left a movement standing on the place: reverse it, so the
  // place is as if it never had one (rule T6, edge case 12).
  beforeAll(async () => {
    const { rows } = await db.execute<{ id: string }>(sql`
      select m.id from treasury_movements m
      join ledger_accounts a on a.id in (m.from_account_id, m.to_account_id)
      where a.code = ${TREASURY_ACCOUNTS['supplier:fake'].code} and m.reverses_movement_id is null
        and not exists (select 1 from treasury_movements r where r.reverses_movement_id = m.id)`);
    for (const { id } of rows) {
      await db.transaction((tx) =>
        reverseMovement(
          tx,
          { movementId: id, idempotencyKey: newId(), reason: 'Test clean-up' },
          actor,
        ),
      );
    }
  });

  it('posts one movement for one key sent twice at once', async () => {
    const input = transfer('outside_usd', 'supplier:fake', { reason: 'Parallel key' });
    const results = await Promise.all(
      [1, 2].map(() => db.transaction((tx) => recordMovement(tx, input, actor))),
    );
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0]?.movement.id).toBe(results[1]?.movement.id);
    await db.transaction((tx) =>
      reverseMovement(
        tx,
        {
          movementId: results[0]?.movement.id as string,
          idempotencyKey: newId(),
          reason: 'Clean up',
        },
        actor,
      ),
    );
  });

  it('lets one of two reversals win', async () => {
    const { movement } = await db.transaction((tx) =>
      recordMovement(
        tx,
        transfer('outside_usd', 'supplier:fake', { reason: 'To reverse twice' }),
        actor,
      ),
    );
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        refusal(
          db.transaction((tx) =>
            reverseMovement(
              tx,
              { movementId: movement.id, idempotencyKey: newId(), reason: 'Reverse it' },
              actor,
            ),
          ),
        ),
      ),
    );
    expect(outcomes.sort()).toEqual(['MOVEMENT_ALREADY_REVERSED', null].sort());
  });

  it('lets one of two openings win', async () => {
    const place = 'supplier:fake';
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        db
          .transaction((tx) =>
            recordMovement(tx, transfer('outside_usd', place, { openingBalance: true }), actor),
          )
          .then(
            (result) => result.movement.id,
            (error: unknown) => (error instanceof TreasuryError ? error.code : error),
          ),
      ),
    );
    const won = outcomes.find((outcome) => outcome !== 'OPENING_BALANCE_EXISTS');
    // A standing opening from an earlier failed run would refuse both.
    expect(outcomes.filter((outcome) => outcome === 'OPENING_BALANCE_EXISTS')).toHaveLength(1);
    await db.transaction((tx) =>
      reverseMovement(
        tx,
        { movementId: won as string, idempotencyKey: newId(), reason: 'Clean up' },
        actor,
      ),
    );
  });
});

describe('the movement guards (migration 0045)', () => {
  /** Inserts a movement row by hand as `role`, in a savepoint; the error's message or null. */
  async function insertRow(
    tx: Transaction,
    values: Partial<typeof treasuryMovements.$inferInsert>,
  ) {
    const account = (endpoint: TreasuryEndpoint) =>
      ensureSystemAccount(tx, TREASURY_ACCOUNTS[endpoint]);
    const journal = await tx.execute<{ id: string }>(sql`
      insert into ledger_journals (id, idempotency_key, kind, posting_count)
      values (${newId()}, ${`test:${newId()}`}, 'treasury', 2) returning id`);
    return tx
      .transaction(async (savepoint) => {
        await savepoint.insert(treasuryMovements).values({
          kind: 'transfer',
          fromAccountId: await account('usdt_trc20'),
          sentUnits: USD,
          sentCurrency: 'USD',
          toAccountId: await account('supplier:fake'),
          receivedUnits: USD,
          receivedCurrency: 'USD',
          reason: 'By hand',
          journalId: journal.rows[0]?.id as string,
          idempotencyKey: newId(),
          adminId: actor.adminId,
          ...values,
        });
        return null;
      })
      .catch((error: unknown) => {
        const cause = (error as { cause?: { message?: string } }).cause;
        return cause?.message ?? (error as Error).message;
      });
  }

  it('refuses a category without outside, a transfer to corrections and an opening not from outside', async () => {
    await rolledBack(async (tx) => {
      const id = (endpoint: TreasuryEndpoint) =>
        ensureSystemAccount(tx, TREASURY_ACCOUNTS[endpoint]);
      expect(await insertRow(tx, { outsideCategory: 'owner' })).toMatch(/category is set exactly/);
      expect(await insertRow(tx, { toAccountId: await id('supplier_corrections') })).toMatch(
        /transfer never touches the corrections account/,
      );
      expect(
        await insertRow(tx, { kind: 'supplier_correction', toAccountId: await id('usdt_bep20') }),
      ).toMatch(/correction is a supplier against the corrections account/);
      expect(await insertRow(tx, { openingBalance: true, outsideCategory: 'owner' })).toMatch(
        /category is set exactly|opening balance comes from outside/,
      );
      expect(await insertRow(tx, { sentCurrency: 'SYP', rate: '1' })).toMatch(/foreign key/);
      expect(await insertRow(tx, { receivedUnits: 2 * USD })).toMatch(/same_currency_check/);
      expect(await insertRow(tx, {})).toBeNull();
    });
  });

  it('keeps movements append-only for the app role and the owner', async () => {
    const { movement } = await db.transaction((tx) =>
      recordMovement(
        tx,
        transfer('outside_usd', 'supplier:fake', { reason: 'Append-only' }),
        actor,
      ),
    );
    for (const target of [connection, owner]) {
      await expect(
        target.pool.query('update treasury_movements set reason = $2 where id = $1', [
          movement.id,
          'Changed',
        ]),
      ).rejects.toThrow(/permission denied|append-only/);
      await expect(
        target.pool.query('delete from treasury_movements where id = $1', [movement.id]),
      ).rejects.toThrow(/permission denied|append-only/);
    }
    await db.transaction((tx) =>
      reverseMovement(
        tx,
        { movementId: movement.id, idempotencyKey: newId(), reason: 'Clean up' },
        actor,
      ),
    );
  });
});
