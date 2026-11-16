import { DEFAULT_RATE_SETTINGS } from '@vertex-digital/contracts';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../client.js';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import { auditEntries, exchangeRates, rateSuggestions, telegramMessages } from '../schema/index.js';
import {
  createSuggestion,
  endSuggestion,
  lockRates,
  newestRate,
  rateInForceAt,
  rateSettingsInForce,
  suggestionFigures,
  writeRate,
} from './index.js';

/*
 * S27 data: the rate's origin check, the one-pending suggestion, the guards of sources,
 * suggestions, reads and settings, the reads' purge, and the write paths under the rate lock.
 * Every write runs in a rolled-back transaction.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);

afterAll(() => Promise.all([connection.close(), owner.close()]));

const jobs = { send: async () => newId() };
const admin = newId();
const panel = { actorKind: 'admin', actorId: admin, channel: 'admin' } as const;

class Rollback extends Error {}

/** Runs `work` in a drizzle transaction that always rolls back. */
async function inRolledBack(work: (tx: Transaction) => Promise<void>) {
  await expect(
    connection.db.transaction(async (tx) => {
      await work(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

async function rolledBack(
  work: (client: pg.PoolClient) => Promise<void>,
  pool: pg.Pool = connection.pool,
) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Runs `sql` under a savepoint and returns the constraint or message it failed with, or null. */
async function violation(client: pg.PoolClient, sql: string, values: unknown[] = []) {
  await client.query('savepoint attempt');
  try {
    await client.query(sql, values);
    await client.query('release savepoint attempt');
    return null;
  } catch (error) {
    await client.query('rollback to savepoint attempt');
    return (error as { constraint?: string }).constraint ?? (error as Error).message;
  }
}

async function rate(client: pg.PoolClient, value = '130') {
  const id = newId();
  await client.query(
    `insert into exchange_rates (id, syp_per_usd, display_step_syp_units, admin_id)
     values ($1, $2, 500, $3)`,
    [id, value, admin],
  );
  return id;
}

async function source(client: pg.PoolClient) {
  const id = newId();
  await client.query(
    `insert into rate_sources (id, kind, label, handle, parser, enabled)
     values ($1, 'telegram_channel', 'قناة', $2, '{"cityWord":null,"sellWord":"مبيع","unit":"new_syp"}', true)`,
    [id, `ch_${id.slice(-12).replaceAll('-', '')}`],
  );
  return id;
}

async function suggestion(client: pg.PoolClient, baseRateId: string) {
  const id = newId();
  await client.query(
    `insert into rate_suggestions (id, proposed_syp_per_usd, base_rate_id, change_percent, reason,
       observation_ids) values ($1, 140, $2, 7.70, 'single_source', '{}')`,
    [id, baseRateId],
  );
  return id;
}

describe('exchange rate origins (S27 data)', () => {
  it('needs an admin except for an automatic rate, and a suggestion for an approved one', () =>
    rolledBack(async (client) => {
      const base = await rate(client);
      const insert = (origin: string, adminId: string | null, suggestionId: string | null) =>
        violation(
          client,
          `insert into exchange_rates (id, syp_per_usd, display_step_syp_units, origin, admin_id,
             suggestion_id) values ($1, 131, 500, $2, $3, $4)`,
          [newId(), origin, adminId, suggestionId],
        );
      expect(await insert('auto', null, null)).toBeNull();
      expect(await insert('auto', admin, null)).toBe('exchange_rates_origin_check');
      expect(await insert('admin', null, null)).toBe('exchange_rates_origin_check');
      expect(await insert('suggestion', admin, null)).toBe('exchange_rates_origin_check');
      const proposal = await suggestion(client, base);
      expect(await insert('admin', admin, proposal)).toBe('exchange_rates_origin_check');
      expect(await insert('suggestion', admin, proposal)).toBeNull();
      expect(await insert('suggestion', admin, proposal)).toBe('exchange_rates_suggestion_idx');
    }));
});

describe('rate suggestions (S27 SG2, SG5)', () => {
  it('keeps at most one pending suggestion', () =>
    rolledBack(async (client) => {
      const base = await rate(client);
      await client.query(`update rate_suggestions set status = 'expired', decided_at = now()
        where status = 'pending'`);
      await suggestion(client, base);
      expect(
        await violation(
          client,
          `insert into rate_suggestions (id, proposed_syp_per_usd, base_rate_id, change_percent,
             reason, observation_ids) values ($1, 141, $2, 8.46, 'single_source', '{}')`,
          [newId(), base],
        ),
      ).toBe('rate_suggestions_one_pending_idx');
    }));

  it('fixes the proposal, ends a suggestion once, and never deletes it', () =>
    rolledBack(async (client) => {
      const base = await rate(client);
      await client.query(`update rate_suggestions set status = 'expired', decided_at = now()
        where status = 'pending'`);
      const id = await suggestion(client, base);
      expect(
        await violation(
          client,
          'update rate_suggestions set proposed_syp_per_usd = 1 where id = $1',
          [id],
        ),
      ).toMatch(/its proposal is fixed/);
      expect(
        await violation(
          client,
          `update rate_suggestions set status = 'rejected', decided_at = now() where id = $1`,
          [id],
        ),
      ).toBe('rate_suggestions_decision_check');
      await client.query(
        `update rate_suggestions set status = 'rejected', decided_at = now(),
           decided_channel = 'panel', admin_id = $2 where id = $1`,
        [id, admin],
      );
      expect(
        await violation(client, `update rate_suggestions set status = 'expired' where id = $1`, [
          id,
        ]),
      ).toMatch(/ended already/);
      expect(await violation(client, 'delete from rate_suggestions where id = $1', [id])).toMatch(
        /permission denied/,
      );
    }));

  it('refuses a suggestion that does not start pending, even to the owner', () =>
    rolledBack(async (client) => {
      const base = await rate(client);
      expect(
        await violation(
          client,
          `insert into rate_suggestions (id, proposed_syp_per_usd, base_rate_id, change_percent,
             reason, observation_ids, status, decided_at) values ($1, 141, $2, 8.46, 'auto_off',
             '{}', 'expired', now())`,
          [newId(), base],
        ),
      ).toMatch(/starts pending/);
      await client.query(`update rate_suggestions set status = 'expired', decided_at = now()
        where status = 'pending'`);
      const id = await suggestion(client, base);
      expect(await violation(client, 'delete from rate_suggestions where id = $1', [id])).toMatch(
        /never deleted/,
      );
    }, owner.pool));
});

describe('rate sources, reads and settings (S27 data)', () => {
  it('archives a source, never deletes it, and keeps its kind', () =>
    rolledBack(async (client) => {
      const id = await source(client);
      expect(
        await violation(client, `update rate_sources set kind = 'sp_today_page' where id = $1`, [
          id,
        ]),
      ).toMatch(/kind is fixed/);
      expect(await violation(client, 'delete from rate_sources where id = $1', [id])).toMatch(
        /permission denied/,
      );
      await client.query('update rate_sources set archived_at = now() where id = $1', [id]);
      expect(
        await violation(client, 'update rate_sources set enabled = false where id = $1', [id]),
      ).toMatch(/archived/);
    }));

  it('allows one live source per kind and handle', () =>
    rolledBack(async (client) => {
      const id = await source(client);
      const { rows } = await client.query<{ handle: string }>(
        'select handle from rate_sources where id = $1',
        [id],
      );
      const again = () =>
        violation(
          client,
          `insert into rate_sources (id, kind, label, handle, parser, enabled)
           values ($1, 'telegram_channel', 'نسخة', $2, '{}', true)`,
          [newId(), rows[0]?.handle],
        );
      expect(await again()).toBe('rate_sources_live_handle_idx');
      // Telegram usernames ignore case: the same channel in capitals is the same source.
      expect(
        await violation(
          client,
          `insert into rate_sources (id, kind, label, handle, parser, enabled)
           values ($1, 'telegram_channel', 'نسخة', upper($2), '{}', true)`,
          [newId(), rows[0]?.handle],
        ),
      ).toBe('rate_sources_live_handle_idx');
      await client.query('update rate_sources set archived_at = now() where id = $1', [id]);
      expect(await again()).toBeNull();
    }));

  it('keeps reads and settings append-only, and a figure only with an ok or out-of-range read', () =>
    rolledBack(async (client) => {
      const id = await source(client);
      const read = newId();
      const insert = (status: string, value: string | null) =>
        violation(
          client,
          `insert into rate_observations (id, source_id, fetched_at, status, syp_per_usd)
           values ($1, $2, now(), $3, $4)`,
          [newId(), id, status, value],
        );
      expect(await insert('ok', null)).toBe('rate_observations_figure_check');
      expect(await insert('no_match', '131')).toBe('rate_observations_figure_check');
      expect(await insert('out_of_range', '13100')).toBeNull();
      await client.query(
        `insert into rate_observations (id, source_id, fetched_at, status, syp_per_usd)
         values ($1, $2, now(), 'ok', 131)`,
        [read, id],
      );
      expect(
        await violation(client, 'update rate_observations set syp_per_usd = 1 where id = $1', [
          read,
        ]),
      ).toMatch(/permission denied/);
      expect(
        await violation(
          client,
          `insert into rate_settings (id, auto_enabled, auto_max_move_bps, agreement_max_spread_bps,
             min_agreeing_sources, drift_window_hours, drift_max_bps, min_move_bps,
             freshness_minutes, silent_alert_hours, telegram_approve_max_bps, poll_minutes, admin_id)
           values ($1, true, 200, 100, 2, 24, 200, 25, 180, 6, 600, 15, $2)`,
          [newId(), admin],
        ),
      ).toBe('rate_settings_telegram_cap_check');
    }));

  it('purges only reads older than 90 days, through the purge function', () =>
    rolledBack(async (client) => {
      const id = await source(client);
      const [old, recent] = [newId(), newId()];
      await client.query(
        `insert into rate_observations (id, source_id, fetched_at, status)
         values ($1, $3, now() - interval '91 days', 'no_match'),
                ($2, $3, now() - interval '89 days', 'no_match')`,
        [old, recent, id],
      );
      expect(await violation(client, 'delete from rate_observations where id = $1', [old])).toMatch(
        /permission denied/,
      );
      await client.query('select purge_rate_observations(10000)');
      const { rows } = await client.query<{ id: string }>(
        'select id from rate_observations where id = any($1)',
        [[old, recent]],
      );
      expect(rows.map((row) => row.id)).toEqual([recent]);
      expect(await violation(client, 'select purge_rate_observations(0)')).toMatch(
        /batch must be between/,
      );
    }));

  it('refuses the owner any other delete of a read, even with the purge flag set by hand', () =>
    rolledBack(async (client) => {
      const id = await source(client);
      const [old, recent] = [newId(), newId()];
      await client.query(
        `insert into rate_observations (id, source_id, fetched_at, status)
         values ($1, $3, now() - interval '91 days', 'no_match'),
                ($2, $3, now() - interval '1 day', 'no_match')`,
        [old, recent, id],
      );
      await client.query(`select set_config('vertex.rate_observations_purge', 'on', true)`);
      expect(
        await violation(client, 'delete from rate_observations where id = $1', [recent]),
      ).toMatch(/append-only/);
      expect(
        await violation(client, `update rate_observations set excerpt = 'x' where id = $1`, [old]),
      ).toMatch(/append-only/);
      expect(await violation(client, 'truncate rate_observations')).toMatch(
        /append-only|referenced/,
      );
    }, owner.pool));
});

describe('rate write paths (S27 AU4, SG2, edge case 4)', () => {
  it('writes an automatic rate with its audit and supersedes the pending suggestion', () =>
    inRolledBack(async (tx) => {
      await tx
        .update(rateSuggestions)
        .set({ status: 'expired', decidedAt: new Date() })
        .where(eq(rateSuggestions.status, 'pending'));
      const { row: base } = await writeRate(
        tx,
        jobs,
        {
          sypPerUsd: '130',
          displayStepSypUnits: 500,
          origin: 'admin',
          adminId: admin,
          suggestionId: null,
        },
        panel,
      );
      const card = await createSuggestion(tx, jobs, {
        sypPerUsd: '140',
        base,
        reason: 'single_source',
        observationIds: [],
        settings: DEFAULT_RATE_SETTINGS,
        now: new Date(),
      });
      expect(card.telegramMessageId).not.toBeNull();
      const observationIds = [newId()];
      const { row, previous } = await writeRate(
        tx,
        jobs,
        {
          sypPerUsd: '131.5',
          displayStepSypUnits: base.displayStepSypUnits,
          origin: 'auto',
          adminId: null,
          suggestionId: null,
          observationIds,
        },
        { actorKind: 'system', actorId: null, channel: 'worker' },
      );
      expect(previous?.id).toBe(base.id);
      expect((await newestRate(tx))?.id).toBe(row.id);
      const [ended] = await tx
        .select()
        .from(rateSuggestions)
        .where(eq(rateSuggestions.id, card.id));
      expect(ended).toMatchObject({ status: 'superseded', adminId: null, decidedChannel: null });
      const [audit] = await tx.select().from(auditEntries).where(eq(auditEntries.entityId, row.id));
      expect(audit).toMatchObject({ actorKind: 'system', channel: 'worker' });
      expect(audit?.details).toMatchObject({
        origin: 'auto',
        observationIds,
        changePercent: '1.16',
      });
      const closed = await tx
        .select({ params: telegramMessages.params })
        .from(telegramMessages)
        .where(eq(telegramMessages.dedupeKey, `rate-suggestion:${card.id}:closed`));
      expect(closed[0]?.params).toMatchObject({
        status: 'superseded',
        cardMessageId: card.telegramMessageId,
      });
    }));

  it('ends a suggestion once: the second end finds nothing pending', () =>
    inRolledBack(async (tx) => {
      await tx
        .update(rateSuggestions)
        .set({ status: 'expired', decidedAt: new Date() })
        .where(eq(rateSuggestions.status, 'pending'));
      const { row: base } = await writeRate(
        tx,
        jobs,
        {
          sypPerUsd: '130',
          displayStepSypUnits: 500,
          origin: 'admin',
          adminId: admin,
          suggestionId: null,
        },
        panel,
      );
      const card = await createSuggestion(tx, jobs, {
        sypPerUsd: '134',
        base,
        reason: 'move_too_large',
        observationIds: [],
        settings: DEFAULT_RATE_SETTINGS,
        now: new Date(),
      });
      const { row: applied } = await writeRate(
        tx,
        jobs,
        {
          sypPerUsd: '134',
          displayStepSypUnits: 500,
          origin: 'suggestion',
          adminId: admin,
          suggestionId: card.id,
        },
        { actorKind: 'admin', actorId: admin, channel: 'telegram' },
      );
      const approved = await endSuggestion(tx, jobs, {
        suggestionId: card.id,
        status: 'approved',
        channel: 'telegram',
        adminId: admin,
        appliedRate: applied,
      });
      expect(approved).toMatchObject({ status: 'approved', appliedRateId: applied.id });
      expect(
        await endSuggestion(tx, jobs, {
          suggestionId: card.id,
          status: 'rejected',
          channel: 'panel',
          adminId: admin,
        }),
      ).toBeNull();
    }));

  it('reads the rate in force at a time, the settings defaults and the figures', () =>
    inRolledBack(async (tx) => {
      const { row } = await writeRate(
        tx,
        jobs,
        {
          sypPerUsd: '130',
          displayStepSypUnits: 500,
          origin: 'admin',
          adminId: admin,
          suggestionId: null,
        },
        panel,
      );
      expect((await rateInForceAt(tx, new Date(Date.now() + 60_000)))?.id).toBe(row.id);
      expect(await rateInForceAt(tx, new Date(0))).not.toBeNull();
      const { values } = await rateSettingsInForce(tx);
      expect(values.telegramApproveMaxBps).toBeLessThanOrEqual(500);
      expect(await suggestionFigures(tx, [])).toEqual([]);
    }));

  it('serializes rate changes: a second change waits for the first to end', async () => {
    let releaseFirst = () => {};
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked = () => {};
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const order: string[] = [];
    const first = connection.db
      .transaction(async (tx) => {
        await lockRates(tx);
        firstLocked();
        await firstHolds;
        order.push('first ends');
        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
    await locked;
    const second = connection.db
      .transaction(async (tx) => {
        await writeRate(
          tx,
          jobs,
          {
            sypPerUsd: '130',
            displayStepSypUnits: 500,
            origin: 'admin',
            adminId: admin,
            suggestionId: null,
          },
          panel,
        );
        order.push('second writes');
        throw new Rollback();
      })
      .catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first ends', 'second writes']);
    // Nothing was committed.
    const rows = await connection.db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.adminId, admin));
    expect(rows).toEqual([]);
  });
});
