import { Inject, Injectable } from '@nestjs/common';
import {
  type MerchantApplication,
  type MerchantApplicationState,
  type MerchantApplicationValues,
  type MerchantApplyRefusal,
  type MerchantPhoto,
  merchantApplyRefusal,
} from '@vertex-digital/contracts';
import {
  applicant,
  applicationColumns,
  currentMerchantSettings,
  type Database,
  latestApplication,
  lockApplicant,
  lockOpenApplication,
  type MerchantApplicationRow,
  merchantApplicationEvents,
  merchantApplications,
  merchantProfiles,
  merchantShopPhotos,
  merchantTermsInForce,
  moveApplication,
  newId,
  queueTelegramMessage,
  recordAudit,
  type Transaction,
  termsVersionNumber,
  withinLimits,
} from '@vertex-digital/db';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import {
  applicationEvents,
  applicationView,
  coded,
  merchantRefusals as refusals,
} from './merchant-records.js';

const HOUR = 60 * 60 * 1000;

/** S20 "API": 5 applications a day, 10 resubmissions and 10 photos an hour, per customer. */
const LIMITS = { submitsPerDay: 5, resubmitsPerHour: 10, photosPerHour: 10 } as const;

/**
 * The customer's side of the merchant application (S20 F28: MA1–MA4, MT1, MT2): the latest
 * application, a submission (idempotent), a resubmission, a withdrawal, the shop photo and the
 * terms acceptance of a directly granted merchant. A customer only ever reaches their own.
 */
@Injectable()
export class MerchantsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
  ) {}

  /** `GET /api/merchant/application`. */
  async state(customerId: string): Promise<MerchantApplicationState> {
    const [latest, settings, terms, person] = await Promise.all([
      latestApplication(this.db, customerId),
      currentMerchantSettings(this.db),
      merchantTermsInForce(this.db),
      applicant(this.db, customerId),
    ]);
    if (!person) throw refusals.notFound('customer');
    const refusal = this.refusal(person, terms !== null, latest, settings.reapplyWaitDays);
    return {
      application: latest
        ? applicationView(
            latest,
            await applicationEvents(this.db, latest.id),
            settings.infoExpiryDays,
          )
        : null,
      canApply: refusal === null,
      availableAt:
        refusal?.code === 'MERCHANT_REAPPLY_TOO_SOON' ? refusal.availableAt.toISOString() : null,
      termsVersionId: terms?.id ?? null,
    };
  }

  /** `POST /api/merchant/application` (MA1, MA2): `created` is false for a replayed key. */
  async submit(
    customerId: string,
    idempotencyKey: string,
    input: MerchantApplicationValues,
    meta: RequestMeta,
  ): Promise<{ application: MerchantApplication; created: boolean }> {
    const replayed = await this.replay(this.db, customerId, idempotencyKey);
    if (replayed) return { application: await this.view(replayed), created: false };
    try {
      const outcome = await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`merchant-key:${idempotencyKey}`}))`,
        );
        const again = await this.replay(tx, customerId, idempotencyKey);
        if (again) return { row: again, created: false };
        const person = await lockApplicant(tx, customerId);
        if (!person) throw refusals.notFound('customer');
        const settings = await currentMerchantSettings(tx);
        const terms = await merchantTermsInForce(tx);
        const latest = await latestApplication(tx, customerId);
        const refusal = this.refusal(person, terms !== null, latest, settings.reapplyWaitDays);
        if (refusal) throw this.refused(refusal);
        this.checkTerms(input.termsVersionId, terms?.id ?? null);
        const [today] = await tx
          .select({ count: count() })
          .from(merchantApplications)
          .where(
            and(
              eq(merchantApplications.customerId, customerId),
              gt(merchantApplications.createdAt, sql`now() - interval '24 hours'`),
            ),
          );
        if ((today?.count ?? 0) >= LIMITS.submitsPerDay) throw refusals.rateLimited();
        await this.checkPhoto(tx, customerId, input.shopPhotoFileId, null);
        const [row] = await tx
          .insert(merchantApplications)
          .values({ id: newId(), customerId, idempotencyKey, ...applicationColumns(input) })
          .returning();
        const application = row as MerchantApplicationRow;
        await tx.insert(merchantApplicationEvents).values({
          id: newId(),
          applicationId: application.id,
          event: 'submitted',
        });
        await recordAudit(tx, {
          action: 'merchant_application.submitted',
          actorKind: 'customer',
          actorId: customerId,
          channel: 'store',
          entityType: 'merchant_application',
          entityId: application.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          details: {
            customerId,
            termsVersion: await termsVersionNumber(tx, input.termsVersionId),
          },
        });
        await this.tellAdmin(tx, application.id, false);
        return { row: application, created: true };
      });
      return { application: await this.view(outcome.row), created: outcome.created };
    } catch (error) {
      if (violatedConstraint(error) === 'merchant_applications_open_idx') {
        throw new CodedException(409, 'MERCHANT_APPLICATION_OPEN', 'An application is open');
      }
      throw coded(error);
    }
  }

  /** `PUT /api/merchant/application` (MA4): the edited form of an application waiting for it. */
  async resubmit(
    customerId: string,
    input: MerchantApplicationValues,
    meta: RequestMeta,
  ): Promise<MerchantApplication> {
    const allowed = await withinLimits(this.db, [
      { key: `merchant-resubmit:${customerId}`, max: LIMITS.resubmitsPerHour, windowMs: HOUR },
    ]);
    if (!allowed) throw refusals.rateLimited();
    try {
      const row = await this.db.transaction(async (tx) => {
        await this.notFrozen(tx, customerId);
        const open = await this.ownOpen(tx, customerId);
        this.checkTerms(input.termsVersionId, (await merchantTermsInForce(tx))?.id ?? null);
        await this.checkPhoto(tx, customerId, input.shopPhotoFileId, open.id);
        const moved = await moveApplication(tx, { jobs: this.jobs }, open, 'resubmit', {
          actor: { kind: 'customer', customerId, ...meta },
          form: input,
        });
        await this.tellAdmin(tx, moved.id, true);
        return moved;
      });
      return this.view(row);
    } catch (error) {
      throw coded(error);
    }
  }

  /** `POST /api/merchant/application/withdraw` (MA4). */
  async withdraw(customerId: string, meta: RequestMeta): Promise<MerchantApplication> {
    try {
      const row = await this.db.transaction(async (tx) => {
        await this.notFrozen(tx, customerId);
        return moveApplication(
          tx,
          { jobs: this.jobs },
          await this.ownOpen(tx, customerId),
          'withdraw',
          { actor: { kind: 'customer', customerId, ...meta } },
        );
      });
      return this.view(row);
    } catch (error) {
      throw coded(error);
    }
  }

  /** `POST /api/merchant/application/photo` (MA3): re-encoded, owned by the customer. */
  async uploadPhoto(customerId: string, upload: Buffer | undefined): Promise<MerchantPhoto> {
    const allowed = await withinLimits(this.db, [
      { key: `merchant-photo:${customerId}`, max: LIMITS.photosPerHour, windowMs: HOUR },
    ]);
    if (!allowed) throw refusals.rateLimited();
    // Access: a verified customer, not frozen, not a merchant.
    const person = await applicant(this.db, customerId);
    if (!person || person.frozenAt !== null || person.archivedAt !== null) {
      throw new CodedException(403, 'ACCOUNT_FROZEN', 'The account is frozen');
    }
    if (person.accountType === 'merchant') {
      throw new CodedException(409, 'ALREADY_MERCHANT', 'The account is a merchant already');
    }
    const prepared = await this.files.prepare('merchant_shop_photo', upload);
    const fileId = await this.db.transaction(async (tx) => {
      const id = await this.files.record(tx, prepared);
      await tx.insert(merchantShopPhotos).values({ fileId: id, customerId });
      return id;
    });
    return { fileId };
  }

  /** `GET /api/merchant/application/photo/:fileId`: the customer's own photo only. */
  async photo(customerId: string, fileId: string): Promise<ServedFile> {
    const [owned] = await this.db
      .select({ fileId: merchantShopPhotos.fileId })
      .from(merchantShopPhotos)
      .where(
        and(eq(merchantShopPhotos.fileId, fileId), eq(merchantShopPhotos.customerId, customerId)),
      );
    const file = owned ? await this.files.serve(fileId, 'merchant_shop_photo') : null;
    if (!file) throw refusals.notFound('photo');
    return file;
  }

  /** `POST /api/merchant/terms` (MT2): a merchant accepts the version in force. */
  async acceptTerms(customerId: string, versionId: string, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [profile] = await tx
        .select()
        .from(merchantProfiles)
        .where(eq(merchantProfiles.customerId, customerId))
        .for('update');
      const person = await lockApplicant(tx, customerId);
      if (!profile || profile.revokedAt !== null || person?.accountType !== 'merchant') {
        throw new CodedException(409, 'NOT_MERCHANT', 'The account is not a merchant');
      }
      const terms = await merchantTermsInForce(tx);
      this.checkTerms(versionId, terms?.id ?? null, 'versionId');
      await tx
        .update(merchantProfiles)
        .set({ termsVersionId: versionId })
        .where(eq(merchantProfiles.customerId, customerId));
      await recordAudit(tx, {
        action: 'merchant.terms_accepted',
        actorKind: 'customer',
        actorId: customerId,
        channel: 'store',
        entityType: 'customer',
        entityId: customerId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { termsVersion: (terms as { version: number }).version },
      });
    });
  }

  private refusal(
    person: {
      accountType: 'customer' | 'merchant';
      frozenAt: Date | null;
      archivedAt: Date | null;
    },
    termsPublished: boolean,
    latest: MerchantApplicationRow | null,
    reapplyWaitDays: number,
  ): MerchantApplyRefusal | null {
    return merchantApplyRefusal({
      accountType: person.accountType,
      frozen: person.frozenAt !== null || person.archivedAt !== null,
      termsPublished,
      latest,
      reapplyWaitDays,
      now: new Date(),
    });
  }

  private refused(refusal: MerchantApplyRefusal): CodedException {
    switch (refusal.code) {
      case 'ACCOUNT_FROZEN':
        return new CodedException(403, refusal.code, 'The account is frozen');
      case 'MERCHANT_APPLICATION_OPEN':
        return new CodedException(409, refusal.code, 'An application is open', {
          applicationId: refusal.applicationId,
        });
      case 'MERCHANT_REAPPLY_TOO_SOON':
        return new CodedException(409, refusal.code, 'Too soon after a rejection', {
          availableAt: refusal.availableAt.toISOString(),
        });
      default:
        return new CodedException(409, refusal.code, 'The customer cannot apply');
    }
  }

  /** Access: a resubmission and a withdrawal need an account that is not frozen. */
  private async notFrozen(tx: Transaction, customerId: string): Promise<void> {
    const person = await lockApplicant(tx, customerId);
    if (!person || person.frozenAt !== null || person.archivedAt !== null) {
      throw new CodedException(403, 'ACCOUNT_FROZEN', 'The account is frozen');
    }
  }

  /** MT2: the version accepted is the one in force. */
  private checkTerms(versionId: string, inForce: string | null, path = 'termsVersionId'): void {
    if (inForce === null) {
      throw new CodedException(409, 'MERCHANT_TERMS_UNAVAILABLE', 'No merchant terms yet');
    }
    if (versionId !== inForce) throw refusals.invalid(path, 'Not the merchant terms in force');
  }

  /** MA3: a photo the customer uploaded, unused by another application. */
  private async checkPhoto(
    tx: Transaction,
    customerId: string,
    fileId: string | null,
    applicationId: string | null,
  ): Promise<void> {
    if (fileId === null) return;
    const [owned] = await tx
      .select({ customerId: merchantShopPhotos.customerId })
      .from(merchantShopPhotos)
      .where(eq(merchantShopPhotos.fileId, fileId));
    const [used] = await tx
      .select({ id: merchantApplications.id })
      .from(merchantApplications)
      .where(eq(merchantApplications.shopPhotoFileId, fileId));
    if (owned?.customerId !== customerId || (used && used.id !== applicationId)) {
      throw refusals.invalid('shopPhotoFileId', 'Not a photo of yours for this application');
    }
  }

  /** The customer's open application `FOR UPDATE`, or `APPLICATION_STATE_INVALID`. */
  private async ownOpen(tx: Transaction, customerId: string): Promise<MerchantApplicationRow> {
    const open = await lockOpenApplication(tx, customerId);
    if (open) return open;
    const latest = await latestApplication(tx, customerId);
    if (!latest) throw refusals.notFound();
    throw refusals.stateInvalid(latest.status);
  }

  private async replay(
    db: Database | Transaction,
    customerId: string,
    idempotencyKey: string,
  ): Promise<MerchantApplicationRow | null> {
    const [row] = await db
      .select()
      .from(merchantApplications)
      .where(eq(merchantApplications.idempotencyKey, idempotencyKey));
    if (!row) return null;
    if (row.customerId !== customerId) throw refusals.keyReused();
    return row;
  }

  private async view(row: MerchantApplicationRow): Promise<MerchantApplication> {
    const settings = await currentMerchantSettings(this.db);
    return applicationView(row, await applicationEvents(this.db, row.id), settings.infoExpiryDays);
  }

  /** The admin's notice: no personal data, the application and how many wait. */
  private async tellAdmin(tx: Transaction, applicationId: string, resubmitted: boolean) {
    const [waiting] = await tx
      .select({ count: count() })
      .from(merchantApplications)
      .where(eq(merchantApplications.status, 'under_review'));
    await queueTelegramMessage(tx, this.jobs, {
      kind: 'merchant_application',
      params: { applicationId, resubmitted, waiting: Math.max(1, waiting?.count ?? 1) },
    });
  }
}
