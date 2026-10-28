import { readFileSync } from 'node:fs';
import { CURRENCY_SCALE, type PaymentMethod } from '@vertex-digital/contracts';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Transaction } from '../client.js';
import { newId } from '../id.js';
import { customers, exchangeRates, paymentReferences, walletAdjustments } from '../schema/index.js';
import { recordMovement, TreasuryError } from '../treasury/movements.js';
import { LedgerError } from './errors.js';
import { claimPaymentReference, paymentReferenceOwner } from './payment-references.js';
import { postJournal } from './post-journal.js';
import { ensureCustomerWallet, ensureSystemAccount } from './wallet.js';

/*
 * Payment references (S03 rule SC14): one claim per method and reference, across every source.
 * Rows written here stay in the test database (append-only); every test uses new references.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db } = connection;

afterAll(() => Promise.all([connection.close(), owner.close()]));

const reference = () => `TX-${newId().slice(-12)}`.toUpperCase();

/** A Sham Cash manual deposit of $1 with `externalReference`, without its claim. */
async function manualDeposit(tx: Transaction, externalReference: string): Promise<string> {
  const customerId = newId();
  await tx.insert(customers).values({
    id: customerId,
    name: 'Test',
    email: `${customerId}@test.vertex-digital.local`,
    phone: '+963900000000',
  });
  const wallet = await ensureCustomerWallet(tx, customerId);
  const counter = await ensureSystemAccount(tx, {
    code: 'adjustments:manual_deposit',
    kind: 'adjustments',
    currency: 'USD',
  });
  const { journalId } = await postJournal(tx, {
    idempotencyKey: `test:${newId()}`,
    kind: 'adjustment',
    postings: [
      { accountId: wallet, amountUnits: CURRENCY_SCALE.USD },
      { accountId: counter, amountUnits: -CURRENCY_SCALE.USD },
    ],
  });
  const id = newId();
  await tx.insert(walletAdjustments).values({
    id,
    customerId,
    direction: 'credit',
    amountUsdUnits: CURRENCY_SCALE.USD,
    category: 'manual_deposit',
    reason: 'A test adjustment',
    depositMethod: 'sham_cash',
    externalReference,
    journalId,
    idempotencyKey: newId(),
    adminId: newId(),
  });
  return id;
}

/** A manual deposit with its claim on `claimed` (its own reference by default), committed. */
function claimedDeposit(
  externalReference: string,
  claimed = externalReference,
  method: PaymentMethod = 'sham_cash',
): Promise<string> {
  return db.transaction(async (tx) => {
    const id = await manualDeposit(tx, externalReference);
    await claimPaymentReference(tx, method, claimed, { walletAdjustmentId: id });
    return id;
  });
}

async function refusalOf(work: Promise<unknown>): Promise<LedgerError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof LedgerError) return error;
    throw error;
  }
  throw new Error('Expected a refusal');
}

async function rolledBack(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

describe('claimPaymentReference (rule SC14)', () => {
  it('stores the reference trimmed and upper-cased', async () => {
    const value = reference();
    const id = await claimedDeposit(` ${value.toLowerCase()} `);
    const rows = await db
      .select({ method: paymentReferences.method, reference: paymentReferences.reference })
      .from(paymentReferences)
      .where(eq(paymentReferences.walletAdjustmentId, id));
    expect(rows).toEqual([{ method: 'sham_cash', reference: value }]);
    expect(await paymentReferenceOwner(db, 'sham_cash', value.toLowerCase())).toEqual({
      kind: 'adjustment',
      id,
    });
    expect(await paymentReferenceOwner(db, 'usdt_trc20', value)).toBeNull();
  });

  it('refuses a second claim in any case or spacing, naming the first, and rolls nothing back', async () => {
    const value = reference();
    const first = await claimedDeposit(value);
    const refusal = await refusalOf(
      db.transaction(async (tx) => {
        const second = await manualDeposit(tx, `${value}x`);
        const error = await refusalOf(
          claimPaymentReference(tx, 'sham_cash', ` ${value.toLowerCase()}`, {
            walletAdjustmentId: second,
          }),
        );
        // The transaction is still usable after the refusal.
        await tx.select().from(paymentReferences).limit(1);
        throw error;
      }),
    );
    expect(refusal.code).toBe('EXTERNAL_REFERENCE_TAKEN');
    expect(refusal.details).toEqual({ kind: 'adjustment', id: first });
  });

  it('lets one of two parallel claims win', async () => {
    const value = reference();
    // Two adjustment references, one claim: as a deposit and an adjustment claiming one transfer.
    const results = await Promise.allSettled([
      claimedDeposit(reference(), value),
      claimedDeposit(reference(), value),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [failed] = results.filter((result) => result.status === 'rejected');
    expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(LedgerError);
    const rows = await db
      .select()
      .from(paymentReferences)
      .where(eq(paymentReferences.reference, value));
    expect(rows).toHaveLength(1);
  });
});

describe('a TXID is claimed once across both USDT networks (audit A1)', () => {
  const txid = () => newId().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);

  it('refuses the TXID under the other network, in either stored form, naming the first', async () => {
    const value = txid();
    const first = await claimedDeposit(reference(), value, 'usdt_bep20');
    for (const [method, spelling] of [
      ['usdt_trc20', value],
      ['usdt_trc20', `0x${value.toUpperCase()}`],
      ['usdt_bep20', `0x${value}`],
    ] as const) {
      const refusal = await refusalOf(claimedDeposit(reference(), spelling, method));
      expect(refusal.code).toBe('EXTERNAL_REFERENCE_TAKEN');
      expect(refusal.details).toEqual({ kind: 'adjustment', id: first });
    }
    expect(await paymentReferenceOwner(db, 'usdt_trc20', value)).toEqual({
      kind: 'adjustment',
      id: first,
    });
    // Sham Cash references are their own space.
    await claimedDeposit(reference(), value, 'sham_cash');
  });

  it('lets one of two parallel claims under opposite networks win', async () => {
    const value = txid();
    const results = await Promise.allSettled([
      claimedDeposit(reference(), value, 'usdt_trc20'),
      claimedDeposit(reference(), value, 'usdt_bep20'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [failed] = results.filter((result) => result.status === 'rejected');
    expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(LedgerError);
  });

  it('is enforced by the database too, the legacy 0X form included', async () => {
    const value = txid().toUpperCase();
    const id = await claimedDeposit(reference(), value, 'usdt_trc20');
    const second = await db.transaction((tx) => manualDeposit(tx, reference()));
    for (const stored of [value, `0X${value}`]) {
      await rolledBack(owner.pool, async (client) => {
        await expect(
          client.query(
            `insert into payment_references (id, method, reference, wallet_adjustment_id)
             values ($1, 'usdt_bep20', $2, $3)`,
            [newId(), stored, second],
          ),
        ).rejects.toThrow(/payment_references_usdt_txid_idx/);
      });
    }
    expect(id).toBeTruthy();
  });
});

describe('payment_references guards', () => {
  it('refuses a reference that is not normalized, and a claim without an owner', async () => {
    await rolledBack(connection.pool, async (client) => {
      await expect(
        client.query(
          `insert into payment_references (id, method, reference) values ($1, 'sham_cash', 'X')`,
          [newId()],
        ),
      ).rejects.toThrow(/payment_references_owner_check/);
    });
    const id = await db.transaction((tx) => manualDeposit(tx, reference()));
    for (const value of ['tx-1', ' TX-1', '']) {
      await rolledBack(connection.pool, async (client) => {
        await expect(
          client.query(
            `insert into payment_references (id, method, reference, wallet_adjustment_id)
             values ($1, 'sham_cash', $2, $3)`,
            [newId(), value, id],
          ),
          // A space or an empty value breaks both checks; PostgreSQL names the first it tries.
        ).rejects.toThrow(/payment_references_reference(_ascii)?_check/);
      });
    }
    // F4-3: another spelling of a transfer (Arabic-Indic digits, a direction mark, a space
    // inside) is never stored, whoever writes the row.
    for (const value of ['٥٢٣٦٠٤٩٦١', '‎523604961', '5236 04961']) {
      await rolledBack(connection.pool, async (client) => {
        await expect(
          client.query(
            `insert into payment_references (id, method, reference, wallet_adjustment_id)
             values ($1, 'sham_cash', $2, $3)`,
            [newId(), value, id],
          ),
        ).rejects.toThrow(/payment_references_reference_ascii_check/);
      });
    }
  });

  it('backfills the claims of S02 manual deposits, keeping the first of a duplicate', async () => {
    const migration = readFileSync(
      new URL('../../migrations/0010_s03_rates_guards.sql', import.meta.url),
      'utf8',
    );
    const backfill = migration.split('--> statement-breakpoint').at(-1) as string;
    const value = reference();
    // Written without claims, as S02 wrote them; the second differs only by spaces.
    const first = await db.transaction((tx) => manualDeposit(tx, value));
    const second = await db.transaction((tx) => manualDeposit(tx, ` ${value} `));
    await rolledBack(owner.pool, async (client) => {
      await client.query(backfill);
      const { rows } = await client.query(
        'select id, method, reference, wallet_adjustment_id from payment_references where reference = $1',
        [value],
      );
      expect(rows).toEqual([
        { id: first, method: 'sham_cash', reference: value, wallet_adjustment_id: first },
      ]);
      expect(second).not.toBe(first);
    });
  });
});

describe('append-only rates and payment references', () => {
  it.each(['exchange_rates', 'payment_references'])(
    'gives the app role SELECT and INSERT only on %s',
    async (table) => {
      const { rows } = await connection.pool.query<{ privileges: Record<string, boolean> }>(
        `select json_object_agg(p, has_table_privilege(current_user, $1, p)) as privileges
         from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p`,
        [table],
      );
      expect(rows[0]?.privileges).toEqual({
        SELECT: true,
        INSERT: true,
        UPDATE: false,
        DELETE: false,
        TRUNCATE: false,
      });
    },
  );

  it('refuses changing or removing a rate or a claim, to the app role and the owner', async () => {
    const rateId = newId();
    await db.insert(exchangeRates).values({
      id: rateId,
      sypPerUsd: '118.0000',
      displayStepSypUnits: 500,
      adminId: newId(),
    });
    const value = reference();
    const adjustmentId = await claimedDeposit(value);
    const [claim] = await db
      .select({ id: paymentReferences.id })
      .from(paymentReferences)
      .where(eq(paymentReferences.walletAdjustmentId, adjustmentId));
    const statements: [string, string][] = [
      ['update exchange_rates set syp_per_usd = 1 where id = $1', rateId],
      ['delete from exchange_rates where id = $1', rateId],
      [`update payment_references set reference = 'X' where id = $1`, claim?.id as string],
      ['delete from payment_references where id = $1', claim?.id as string],
    ];
    for (const [statement, id] of statements) {
      await rolledBack(connection.pool, async (client) => {
        await expect(client.query(statement, [id])).rejects.toThrow(/permission denied/);
      });
      await rolledBack(owner.pool, async (client) => {
        await expect(client.query(statement, [id])).rejects.toThrow(/is append-only/);
      });
    }
  });

  it('refuses a rate of zero and a display step outside whole pounds from 1 to 50', async () => {
    for (const [rate, step, check] of [
      ['0', 500, 'exchange_rates_rate_check'],
      ['118', 50, 'exchange_rates_display_step_check'],
      ['118', 5100, 'exchange_rates_display_step_check'],
      ['118', 250, 'exchange_rates_display_step_check'],
    ] as const) {
      await rolledBack(connection.pool, async (client) => {
        await expect(
          client.query(
            `insert into exchange_rates (id, syp_per_usd, display_step_syp_units, admin_id)
             values ($1, $2, $3, $1)`,
            [newId(), rate, step],
          ),
        ).rejects.toThrow(new RegExp(check));
      });
    }
  });
});

describe('unclaimed receipts (audit A09-3)', () => {
  const actor = { adminId: newId(), ipAddress: '203.0.113.9', userAgent: 'Test' };
  const unclaimed = (to: 'usdt_trc20' | 'sham_cash_syp', externalReference: string) => ({
    idempotencyKey: newId(),
    kind: 'transfer' as const,
    from: to === 'sham_cash_syp' ? ('outside_syp' as const) : ('outside_usd' as const),
    to,
    sentUnits: to === 'sham_cash_syp' ? 10_000 * CURRENCY_SCALE.SYP : 5 * CURRENCY_SCALE.USD,
    receivedUnits: to === 'sham_cash_syp' ? 10_000 * CURRENCY_SCALE.SYP : 5 * CURRENCY_SCALE.USD,
    outsideCategory: 'unclaimed_receipt' as const,
    openingBalance: false,
    orderId: null,
    externalReference,
    reason: 'A transfer nobody claimed',
  });
  /** Runs `work` in a transaction that is rolled back: the places stay as other tests left them. */
  async function rolledBackTx(work: (tx: Transaction) => Promise<void>) {
    const rollback = new Error('rollback');
    await db
      .transaction(async (tx) => {
        await work(tx);
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
  }

  it('refuses a claim on a TXID booked as an unclaimed receipt, under either network', async () => {
    await rolledBackTx(async (tx) => {
      const txid = newId().replaceAll('-', '').padEnd(64, 'a');
      const { movement } = await recordMovement(tx, unclaimed('usdt_trc20', txid), actor);
      const id = await manualDeposit(tx, reference());
      const error = await refusalOf(
        claimPaymentReference(tx, 'usdt_bep20', `0x${txid.toUpperCase()}`, {
          walletAdjustmentId: id,
        }),
      );
      expect(error.code).toBe('EXTERNAL_REFERENCE_TAKEN');
      expect(error.details).toEqual({ kind: 'treasury_movement', id: movement.id });
    });
  });

  it('refuses booking as an unclaimed receipt a reference a deposit claimed', async () => {
    await rolledBackTx(async (tx) => {
      const claimed = reference();
      const id = await manualDeposit(tx, claimed);
      await claimPaymentReference(tx, 'sham_cash', claimed, { walletAdjustmentId: id });
      const refused = await recordMovement(
        tx,
        unclaimed('sham_cash_syp', claimed.toLowerCase()),
        actor,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(TreasuryError);
      expect(refused).toMatchObject({
        code: 'EXTERNAL_REFERENCE_TAKEN',
        details: { kind: 'adjustment', id },
      });
    });
  });
});
