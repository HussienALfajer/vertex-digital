import { Inject, Injectable } from '@nestjs/common';
import type { RateSettings, RateSettingsValues } from '@vertex-digital/contracts';
import {
  type Database,
  lockRates,
  newId,
  rateSettings,
  rateSettingsInForce,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { AdminAuthService } from '../admin/index.js';

/**
 * S27 ST1, ST2: the automatic updates' settings, append-only versions. The panel saves a whole
 * version (re-authenticated); Telegram may only turn automatic updates off (ADR 0019, 0041).
 */
@Injectable()
export class RateSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly admins: AdminAuthService,
  ) {}

  /** `GET /api/admin/rate-settings`: the version in force, or the defaults (updates off). */
  async get(): Promise<RateSettings> {
    const { row, values } = await rateSettingsInForce(this.db);
    const names = await this.admins.namesOf(row ? [row.adminId] : []);
    return {
      ...values,
      id: row?.id ?? null,
      adminName: (row && names.get(row.adminId)) ?? null,
      createdAt: row?.createdAt.toISOString() ?? null,
    };
  }

  /** `POST /api/admin/rate-settings`: a new version when anything changed, and its audit entry. */
  async change(
    adminId: string,
    input: RateSettingsValues,
    meta: RequestMeta,
  ): Promise<RateSettings> {
    await this.db.transaction((tx) => this.save(tx, adminId, input, 'admin', meta));
    return this.get();
  }

  /**
   * ST1: Telegram's "إيقاف التحديث التلقائي" after its confirm button, in the update's
   * transaction. False when automatic updates were already off.
   */
  async turnOffIn(tx: Transaction, adminId: string, meta: RequestMeta): Promise<boolean> {
    // Under the lock, so a version the panel saved meanwhile is the one turned off.
    await lockRates(tx);
    const { values } = await rateSettingsInForce(tx);
    if (!values.autoEnabled) return false;
    return this.save(tx, adminId, { ...values, autoEnabled: false }, 'telegram', meta);
  }

  /** Under the rate lock: a poll deciding at the same time reads one version or the other. */
  private async save(
    tx: Transaction,
    adminId: string,
    input: RateSettingsValues,
    channel: 'admin' | 'telegram',
    meta: RequestMeta,
  ): Promise<boolean> {
    await lockRates(tx);
    const { values: before } = await rateSettingsInForce(tx);
    const changed = (Object.keys(input) as (keyof RateSettingsValues)[]).filter(
      (key) => input[key] !== before[key],
    );
    if (changed.length === 0) return false;
    const id = newId();
    await tx.insert(rateSettings).values({ id, ...input, adminId });
    const pick = (from: RateSettingsValues) =>
      Object.fromEntries(changed.map((key) => [key, from[key]])) as Partial<RateSettingsValues>;
    await recordAudit(tx, {
      action: 'rate_settings.changed',
      actorKind: 'admin',
      actorId: adminId,
      channel,
      entityType: 'rate_settings',
      entityId: id,
      details: { settingsId: id, before: pick(before), after: pick(input) },
      ...meta,
    });
    return true;
  }
}
