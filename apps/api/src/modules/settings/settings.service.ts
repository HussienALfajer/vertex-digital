import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminSwitches,
  type ChangeSwitch,
  STORE_SWITCH_DEFAULTS,
  STORE_SWITCHES,
  type StoreStatus,
  type StoreSwitch,
  type StoreSwitchValues,
  SUPPLIER_PAUSE_SWITCHES,
  type SupplierCode,
  type SwitchChannel,
  type SwitchHistoryPage,
  type SwitchHistoryQuery,
  storeStatus,
} from '@vertex-digital/contracts';
import {
  type Database,
  newId,
  queueStoreRevalidate,
  queueTelegramMessage,
  recordAudit,
  repriceProducts,
  routedProductIds,
  storeSwitchChanges,
  type Transaction,
} from '@vertex-digital/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';

/**
 * The switches lock (rules SW2, SW5): a change takes it exclusively, a deposit creation shared,
 * so a creation either commits before a stop or sees it. A transaction-level advisory lock, since
 * the app role cannot lock rows of an append-only table.
 */
const SWITCHES_KEY = sql`hashtext('settings')`;

/** The supplier each pause switch stops (S07 rule SP3). */
const PAUSED_SUPPLIER = new Map(
  Object.entries(SUPPLIER_PAUSE_SWITCHES).map(([code, name]) => [name, code as SupplierCode]),
);

type Executor = Database | Transaction;

interface SwitchState {
  value: boolean;
  since: Date | null;
  channel: SwitchChannel | null;
}

/**
 * The store switches (S05 F26, rules SW1–SW8): the only writer of `store_switch_changes`. Other
 * modules read them through `values()`, per request and never cached (rule SW1), or through
 * `valuesForCreation(tx)` inside a deposit creation (rule SW5).
 */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
  ) {}

  /** Every switch's current value: its newest row, or its default. */
  async values(executor: Executor = this.db): Promise<StoreSwitchValues> {
    const states = await this.states(executor);
    return Object.fromEntries(
      STORE_SWITCHES.map((name) => [name, states[name].value]),
    ) as StoreSwitchValues;
  }

  /**
   * Inside a deposit creation's or a purchase's transaction: the shared lock, then the values (rule
   * SW5, S08 rule O2), so a creation commits before a stop or sees it.
   */
  async valuesForCreation(tx: Transaction): Promise<StoreSwitchValues> {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${SWITCHES_KEY})`);
    return this.values(tx);
  }

  /** `GET /api/store/status`. */
  async status(): Promise<StoreStatus> {
    return storeStatus(await this.values());
  }

  /** `GET /api/admin/switches`. */
  async adminSwitches(executor: Executor = this.db): Promise<AdminSwitches> {
    const states = await this.states(executor);
    return {
      switches: STORE_SWITCHES.map((name) => ({
        switch: name,
        value: states[name].value,
        default: STORE_SWITCH_DEFAULTS[name],
        since: states[name].since?.toISOString() ?? null,
        channel: states[name].channel,
      })),
    };
  }

  /**
   * Rule SW2: under the switches lock, a change to a new value writes its row, its audit entry and
   * its Telegram notice (rule AL2) in one transaction, and a supplier's pause reprices its routed
   * products (S07 rule SP3); a change to the current value writes nothing. Re-authentication and
   * the channel's limits (rule SW3) are the caller's.
   */
  async change(
    adminId: string,
    input: ChangeSwitch,
    channel: SwitchChannel,
    meta: RequestMeta,
  ): Promise<AdminSwitches> {
    return this.db.transaction(async (tx) => {
      await this.changeIn(tx, adminId, input, channel, meta);
      return this.adminSwitches(tx);
    });
  }

  /** `change` inside the caller's transaction (the Telegram stop, rule AL4); true if it changed. */
  async changeIn(
    tx: Transaction,
    adminId: string,
    input: ChangeSwitch,
    channel: SwitchChannel,
    meta: RequestMeta,
  ): Promise<boolean> {
    await tx.execute(sql`select pg_advisory_xact_lock(${SWITCHES_KEY})`);
    const before = (await this.values(tx))[input.switch];
    if (before === input.value) return false;
    const id = newId();
    await tx.insert(storeSwitchChanges).values({
      id,
      switch: input.switch,
      value: input.value,
      adminId,
      channel,
    });
    await recordAudit(tx, {
      action: 'store_switch.changed',
      actorKind: 'admin',
      actorId: adminId,
      channel,
      entityType: 'store_switch',
      entityId: id,
      reason: null,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { switch: input.switch, before, after: input.value },
    });
    await queueTelegramMessage(tx, this.jobs, {
      kind: 'switch_changed',
      params: { switch: input.switch, value: input.value, channel },
      dedupeKey: `switch:${id}`,
    });
    // A paused supplier's routes are unusable at once, and usable again on resume (rule SP3).
    const supplier = PAUSED_SUPPLIER.get(input.switch);
    if (supplier) {
      await repriceProducts(tx, {
        productIds: await routedProductIds(tx, [supplier]),
        cause: 'route_change',
        context: routingContext(this.env),
      });
      // S09 rule SF4: the store shows the products' new availability.
      await queueStoreRevalidate(tx, this.jobs);
    }
    return true;
  }

  /** `GET /api/admin/switches/history`: newest first, one switch or all. */
  async history(query: SwitchHistoryQuery): Promise<SwitchHistoryPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db
      .select({ row: storeSwitchChanges, at: cursorTime(storeSwitchChanges.createdAt) })
      .from(storeSwitchChanges)
      .where(
        and(
          query.switch ? eq(storeSwitchChanges.switch, query.switch) : undefined,
          cursor ? after(storeSwitchChanges.createdAt, storeSwitchChanges.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(storeSwitchChanges.createdAt), desc(storeSwitchChanges.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, ({ row, at }) => ({ at, id: row.id }));
    return {
      items: page.items.map(({ row }) => ({
        id: row.id,
        switch: row.switch,
        value: row.value,
        channel: row.channel,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** The newest row of each switch (`distinct on` over the `(switch, created_at)` index). */
  private async states(executor: Executor): Promise<Record<StoreSwitch, SwitchState>> {
    const rows = await executor
      .selectDistinctOn([storeSwitchChanges.switch])
      .from(storeSwitchChanges)
      .orderBy(
        storeSwitchChanges.switch,
        desc(storeSwitchChanges.createdAt),
        desc(storeSwitchChanges.id),
      );
    const byName = new Map(rows.map((row) => [row.switch, row]));
    return Object.fromEntries(
      STORE_SWITCHES.map((name) => {
        const row = byName.get(name);
        return [
          name,
          row
            ? { value: row.value, since: row.createdAt, channel: row.channel }
            : { value: STORE_SWITCH_DEFAULTS[name], since: null, channel: null },
        ];
      }),
    ) as Record<StoreSwitch, SwitchState>;
  }
}
