import { Inject, Injectable } from '@nestjs/common';
import {
  DEPOSIT_SETTINGS_DEFAULTS,
  type DepositSettings,
  type DepositSettingsValues,
  isWithinReviewHours,
  REVIEW_ETA_SAMPLE_DAYS,
  REVIEW_ETA_SAMPLE_SIZE,
  type ReviewEta,
  reviewEta,
} from '@vertex-digital/contracts';
import { type Database, depositSettings, deposits, newId, recordAudit } from '@vertex-digital/db';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { FilesService } from '../files/index.js';

type SettingsRow = typeof depositSettings.$inferSelect;

/** The settings in force, as the deposit rules read them. */
export interface CurrentSettings extends DepositSettingsValues {
  id: string;
  createdAt: Date;
}

const FIELDS = Object.keys(DEPOSIT_SETTINGS_DEFAULTS) as (keyof DepositSettingsValues)[];

/** Serializes saves, so each version's audit entry compares with the version it replaces. */
const SETTINGS_SAVE_LOCK = sql`select pg_advisory_xact_lock(hashtext('deposit_settings'))`;

/** How far back the ETA sample reaches, at most: the decisions of the sample window. */
const ETA_SCAN_LIMIT = 200;

/**
 * The Sham Cash deposit settings (S03): versions, the QR images and the review ETA (rule SC13).
 * The only writer of `deposit_settings`.
 */
@Injectable()
export class DepositSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly files: FilesService,
  ) {}

  /** The newest version, or null before the first save (rule SC1). */
  async current(): Promise<CurrentSettings | null> {
    const [row] = await this.db
      .select()
      .from(depositSettings)
      .orderBy(desc(depositSettings.createdAt), desc(depositSettings.id))
      .limit(1);
    return row ? toCurrent(row) : null;
  }

  /** `GET /api/admin/deposit-settings`: the current version, or the defaults to start from. */
  async read(): Promise<DepositSettings> {
    const current = await this.current();
    if (!current) return { ...DEPOSIT_SETTINGS_DEFAULTS, saved: false, savedAt: null };
    const { id: _, createdAt, ...values } = current;
    return { ...values, saved: true, savedAt: createdAt.toISOString() };
  }

  /** `PUT /api/admin/deposit-settings`: a new version and its audit entry. */
  async save(
    adminId: string,
    input: DepositSettingsValues,
    meta: RequestMeta,
  ): Promise<DepositSettings> {
    const qrFiles = [input.sypQrFileId, input.usdQrFileId].filter((id) => id !== null);
    const known = await this.files.existing(qrFiles, 'sham_cash_qr');
    const unknown = (['sypQrFileId', 'usdQrFileId'] as const).filter(
      (key) => input[key] !== null && !known.has(input[key] as string),
    );
    if (unknown.length > 0) {
      throw new CodedException(
        400,
        'VALIDATION_FAILED',
        'Unknown QR image',
        unknown.map((key) => ({ path: [key], message: 'Upload the QR image first' })),
      );
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(SETTINGS_SAVE_LOCK);
      const [previous] = await tx
        .select()
        .from(depositSettings)
        .orderBy(desc(depositSettings.createdAt), desc(depositSettings.id))
        .limit(1);
      const before = previous ? toCurrent(previous) : null;
      const id = newId();
      await tx.insert(depositSettings).values({
        id,
        ...input,
        adminId,
        // The insert's own time: a save that waited for the lock is still the newer version.
        createdAt: sql`clock_timestamp()`,
      });
      const changed = FIELDS.filter((key) => !before || before[key] !== input[key]);
      await recordAudit(tx, {
        action: 'deposit_settings.changed',
        actorKind: 'admin',
        actorId: adminId,
        channel: 'admin',
        entityType: 'deposit_settings',
        entityId: id,
        reason: null,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          settingsId: id,
          before: before ? pick(before, changed) : {},
          after: pick(input, changed),
        },
      });
    });
    return this.read();
  }

  /** `POST /api/admin/deposit-settings/qr`: a re-encoded PNG, named by a later save. */
  async uploadQr(upload: Buffer | undefined): Promise<{ fileId: string }> {
    return { fileId: await this.files.store('sham_cash_qr', upload) };
  }

  /**
   * What the customer is told about the review time now (rule SC13), or null before the first
   * save. The sample: the last 20 decided Sham Cash deposits of 14 days submitted within hours.
   */
  async eta(settings: CurrentSettings | null, now = new Date()): Promise<ReviewEta | null> {
    if (!settings) return null;
    const hours = { start: settings.reviewHoursStart, end: settings.reviewHoursEnd };
    const rows = await this.db
      .select({ submittedAt: deposits.submittedAt, decidedAt: deposits.decidedAt })
      .from(deposits)
      .where(
        and(
          eq(deposits.method, 'sham_cash'),
          inArray(deposits.status, ['credited', 'rejected']),
          isNotNull(deposits.decidedAt),
          sql`${deposits.decidedAt} > now() - make_interval(days => ${REVIEW_ETA_SAMPLE_DAYS})`,
        ),
      )
      .orderBy(desc(deposits.decidedAt))
      .limit(ETA_SCAN_LIMIT);
    const durations = rows
      .filter((row) => row.submittedAt && isWithinReviewHours(row.submittedAt, hours))
      .slice(0, REVIEW_ETA_SAMPLE_SIZE)
      .map(
        (row) => ((row.decidedAt as Date).getTime() - (row.submittedAt as Date).getTime()) / 1000,
      );
    return reviewEta(now, hours, settings.reviewTargetMinutes, durations);
  }
}

function toCurrent(row: SettingsRow): CurrentSettings {
  return {
    id: row.id,
    createdAt: row.createdAt,
    shamCashAccountName: row.shamCashAccountName,
    shamCashAccountNumber: row.shamCashAccountNumber,
    sypEnabled: row.sypEnabled,
    usdEnabled: row.usdEnabled,
    sypQrFileId: row.sypQrFileId,
    usdQrFileId: row.usdQrFileId,
    minDepositUsdUnits: row.minDepositUsdUnits,
    newAccountPerDepositUsdUnits: row.newAccountPerDepositUsdUnits,
    newAccountDailyUsdUnits: row.newAccountDailyUsdUnits,
    establishedPerDepositUsdUnits: row.establishedPerDepositUsdUnits,
    establishedDailyUsdUnits: row.establishedDailyUsdUnits,
    // `time` reads as `HH:MM:SS`; the settings speak `HH:MM`.
    reviewHoursStart: row.reviewHoursStart.slice(0, 5),
    reviewHoursEnd: row.reviewHoursEnd.slice(0, 5),
    reviewTargetMinutes: row.reviewTargetMinutes,
    flagNewAccountUsdUnits: row.flagNewAccountUsdUnits,
    flagVelocityCount: row.flagVelocityCount,
  };
}

function pick(values: DepositSettingsValues, keys: (keyof DepositSettingsValues)[]) {
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}
