import { Inject, Injectable } from '@nestjs/common';
import {
  MERCHANT_LEVELS_MAX,
  type MerchantLevel,
  type MerchantLevelInput,
  type MerchantLevelList,
  priceKindOf,
} from '@vertex-digital/contracts';
import {
  type Database,
  levelRows,
  type MerchantLevelRow,
  merchantLevels,
  queueAllMerchantLevels,
  recordAudit,
  type Transaction,
  usableList,
} from '@vertex-digital/db';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import { JobsService } from '../../core/jobs/index.js';
import { coded, merchantRefusals as refusals } from './merchant-records.js';
import type { MerchantActor } from './merchants-admin.service.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** One writer of the levels at a time: the count of LV1 and the names and thresholds. */
const LEVELS_LOCK = sql`select pg_advisory_xact_lock(hashtext('merchant-levels'))`;

/**
 * Volume levels in the panel (S21 F39, LV1, LV6): at most 10 live levels with distinct names and
 * thresholds, each on a wholesale or custom list that is unarchived and priced (taken `FOR SHARE`
 * against an archive, S20 LS5). Every change is audited and requeues every merchant's
 * recomputation in its transaction.
 */
@Injectable()
export class MerchantLevelsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
  ) {}

  /** `GET /api/admin/merchant-levels`: live levels by threshold, then archived ones. */
  async list(): Promise<MerchantLevelList> {
    const rows = await levelRows(this.db);
    return {
      items: rows.map((row) =>
        view(row.level, { ...row.list, priceKind: priceKindOf(row.list.kind) }, row.merchants),
      ),
    };
  }

  /** LV1. */
  async create(input: MerchantLevelInput, actor: MerchantActor): Promise<MerchantLevel> {
    const id = await this.write(async (tx) => {
      const [live] = await tx
        .select({ count: count() })
        .from(merchantLevels)
        .where(isNull(merchantLevels.archivedAt));
      if ((live?.count ?? 0) >= MERCHANT_LEVELS_MAX) {
        throw new CodedException(409, 'MERCHANT_LEVELS_LIMIT_REACHED', 'Ten live levels already', {
          limit: MERCHANT_LEVELS_MAX,
        });
      }
      await levelList(tx, input.priceListId);
      const [row] = await tx.insert(merchantLevels).values(input).returning();
      const level = row as MerchantLevelRow;
      await this.audit(tx, actor, level.id, 'merchant_level.created', values(level));
      return level.id;
    });
    return this.one(id);
  }

  /** LV1, LV6: a live level's name, threshold or list. */
  async update(
    id: string,
    input: MerchantLevelInput,
    actor: MerchantActor,
  ): Promise<MerchantLevel> {
    await this.write(async (tx) => {
      const before = await this.lockLive(tx, id);
      if (input.priceListId !== before.priceListId) await levelList(tx, input.priceListId);
      const [row] = await tx
        .update(merchantLevels)
        .set(input)
        .where(eq(merchantLevels.id, id))
        .returning();
      await this.audit(tx, actor, id, 'merchant_level.updated', {
        before: values(before),
        after: values(row as MerchantLevelRow),
      });
      return id;
    });
    return this.one(id);
  }

  /** LV6, edge case 4: its merchants recompute to the next lower level or none. */
  async archive(id: string, actor: MerchantActor): Promise<MerchantLevel> {
    await this.write(async (tx) => {
      const level = await this.lockLive(tx, id);
      await tx
        .update(merchantLevels)
        .set({ archivedAt: new Date() })
        .where(eq(merchantLevels.id, id));
      await this.audit(tx, actor, id, 'merchant_level.archived', values(level));
      return id;
    });
    return this.one(id);
  }

  /** A change under the levels' lock, with every merchant's recomputation queued (LV4, LV6). */
  private async write(change: (tx: Transaction) => Promise<string>): Promise<string> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(LEVELS_LOCK);
        const id = await change(tx);
        await queueAllMerchantLevels(tx, this.jobs);
        return id;
      });
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (constraint === 'merchant_levels_name_idx') {
        throw new CodedException(409, 'MERCHANT_LEVEL_NAME_TAKEN', 'Another level has this name');
      }
      if (constraint === 'merchant_levels_threshold_idx') {
        throw new CodedException(
          409,
          'MERCHANT_LEVEL_THRESHOLD_TAKEN',
          'Another level has this threshold',
        );
      }
      throw coded(error);
    }
  }

  private async lockLive(tx: Transaction, id: string): Promise<MerchantLevelRow> {
    if (!isUuid(id)) throw refusals.notFound('level');
    const [row] = await tx
      .select()
      .from(merchantLevels)
      .where(and(eq(merchantLevels.id, id), isNull(merchantLevels.archivedAt)))
      .for('no key update');
    if (!row) throw refusals.notFound('level');
    return row;
  }

  private audit(
    tx: Transaction,
    actor: MerchantActor,
    id: string,
    action: 'merchant_level.created' | 'merchant_level.updated' | 'merchant_level.archived',
    details: object,
  ) {
    return recordAudit(tx, {
      action,
      actorKind: 'admin',
      actorId: actor.adminId,
      channel: 'admin',
      entityType: 'merchant_level',
      entityId: id,
      ipAddress: actor.meta.ipAddress,
      userAgent: actor.meta.userAgent,
      details,
    } as Parameters<typeof recordAudit>[1]);
  }

  private async one(id: string): Promise<MerchantLevel> {
    const level = (await this.list()).items.find((item) => item.id === id);
    if (!level) throw refusals.notFound('level');
    return level;
  }
}

/** LV1: a wholesale or custom list, unarchived and priced, `FOR SHARE` against an archive. */
async function levelList(tx: Transaction, priceListId: string) {
  const list = await usableList(tx, priceListId);
  if (list.kind !== 'wholesale' && list.kind !== 'custom') {
    throw refusals.invalid('priceListId', 'A level takes a wholesale or custom list');
  }
  return list;
}

function values(level: MerchantLevelRow): MerchantLevelInput {
  return {
    nameAr: level.nameAr,
    monthlyThresholdUsdUnits: level.monthlyThresholdUsdUnits,
    priceListId: level.priceListId,
  };
}

function view(
  level: MerchantLevelRow,
  list: MerchantLevel['priceList'],
  merchantCount: number,
): MerchantLevel {
  return {
    id: level.id,
    nameAr: level.nameAr,
    monthlyThresholdUsdUnits: level.monthlyThresholdUsdUnits,
    priceList: list,
    merchantCount,
    createdAt: level.createdAt.toISOString(),
    archivedAt: level.archivedAt?.toISOString() ?? null,
  };
}
