import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminCustomer,
  type AdminMerchantApplication,
  type AdminMerchantApplicationPage,
  type AdminMerchantPage,
  applicationTransition,
  DEPOSIT_SETTINGS_DEFAULTS,
  type GrantMerchant,
  type MerchantApplicationListQuery,
  type MerchantListQuery,
  type MerchantSettings,
  type MerchantSettingsInput,
  merchantLimitsBelowMinimum,
  priceKindOf,
} from '@vertex-digital/contracts';
import {
  type AdminActor,
  applicantOf,
  applicationQueue,
  approvedListOf,
  currentMerchantSettings,
  type Database,
  grantMerchant,
  lockApplication,
  lockCustomer,
  lockOpenApplication,
  type MerchantApplicationRow,
  merchantApplications,
  merchantPage,
  merchantSettings,
  moveApplication,
  newId,
  recordAudit,
  revokeMerchant,
  termsVersionNumber,
} from '@vertex-digital/db';
import { and, asc, count, desc, eq, min, ne } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { decodeCursor, encodeCursor } from '../../core/lists/cursor.js';
import { CustomersService } from '../customers/index.js';
import { DepositSettingsService } from '../deposits/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import {
  applicationEvents,
  applicationView,
  coded,
  merchantRefusals as refusals,
  settingsView,
} from './merchant-records.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Who acts in the panel. */
export interface MerchantActor {
  adminId: string;
  meta: RequestMeta;
}

/**
 * The panel's side of merchants (S20 F28: MA4–MA8, MD1, PO5): the applications queue and
 * decisions, the direct grant and the revocation, the merchants list and the merchant settings.
 * An approval or a grant locks the customer before the application (the order a submission's
 * `FOR SHARE` and every grant follow).
 */
@Injectable()
export class MerchantsAdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly customers: CustomersService,
    private readonly depositSettings: DepositSettingsService,
  ) {}

  /** `GET /api/admin/merchant-applications` (MA8). */
  async queue(query: MerchantApplicationListQuery): Promise<AdminMerchantApplicationPage> {
    const rows = await applicationQueue(this.db, {
      status: query.status ?? null,
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit,
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        id: row.id,
        status: row.status,
        tradeName: row.tradeName,
        governorate: row.governorate,
        activity: row.activity,
        monthlyVolume: row.monthlyVolume,
        submittedAt: row.submittedAt.toISOString(),
        customer: {
          id: row.customerId,
          name: row.name,
          email: row.email,
          frozen: row.frozen,
          sharedPhone: row.sharedPhone,
          newAccount: row.newAccount,
        },
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    };
  }

  /** `GET /api/admin/merchant-applications/:id`. */
  async detail(id: string): Promise<AdminMerchantApplication> {
    const row = await this.find(id);
    const [settings, events, customer, termsVersion, earlier, approved] = await Promise.all([
      currentMerchantSettings(this.db),
      applicationEvents(this.db, row.id),
      applicantOf(this.db, row.customerId),
      termsVersionNumber(this.db, row.termsVersionId),
      this.db
        .select({
          id: merchantApplications.id,
          status: merchantApplications.status,
          submittedAt: merchantApplications.submittedAt,
          decidedAt: merchantApplications.decidedAt,
        })
        .from(merchantApplications)
        .where(
          and(
            eq(merchantApplications.customerId, row.customerId),
            ne(merchantApplications.id, row.id),
          ),
        )
        .orderBy(desc(merchantApplications.submittedAt)),
      approvedListOf(this.db, row.approvedPriceListId),
    ]);
    return {
      ...applicationView(row, events, settings.infoExpiryDays),
      customer,
      termsVersion,
      approvedPriceList: approved,
      earlier: earlier.map((item) => ({
        id: item.id,
        status: item.status,
        submittedAt: item.submittedAt.toISOString(),
        decidedAt: item.decidedAt?.toISOString() ?? null,
      })),
    };
  }

  /** `GET /api/admin/merchant-applications/:id/photo`. */
  async photo(id: string): Promise<ServedFile> {
    const row = await this.find(id);
    const file = row.shopPhotoFileId
      ? await this.files.serve(row.shopPhotoFileId, 'merchant_shop_photo')
      : null;
    if (!file) throw refusals.notFound('photo');
    return file;
  }

  /** MA4: request information or reject, the application locked. */
  async decide(
    id: string,
    action: 'request_info' | 'reject',
    message: string,
    actor: MerchantActor,
  ): Promise<AdminMerchantApplication> {
    if (!isUuid(id)) throw refusals.notFound();
    try {
      await this.db.transaction(async (tx) => {
        const row = await lockApplication(tx, id);
        if (!row) throw refusals.notFound();
        await moveApplication(tx, { jobs: this.jobs }, row, action, {
          actor: this.applicationActor(actor),
          message,
        });
      });
    } catch (error) {
      throw coded(error);
    }
    return this.detail(id);
  }

  /** MA5: approval with a list (wholesale by default), the customer then the application locked. */
  async approve(
    id: string,
    priceListId: string | undefined,
    actor: MerchantActor,
  ): Promise<AdminMerchantApplication> {
    const found = await this.find(id);
    try {
      await this.db.transaction(async (tx) => {
        const customer = await lockCustomer(tx, found.customerId);
        const row = (await lockApplication(tx, id)) as MerchantApplicationRow;
        if (applicationTransition(row.status, 'approve') === null) {
          throw refusals.stateInvalid(row.status);
        }
        const { effectiveListId } = await grantMerchant(tx, { jobs: this.jobs }, customer, {
          tradeName: row.tradeName,
          governorate: row.governorate,
          city: row.city,
          applicationId: row.id,
          termsVersionId: row.termsVersionId,
          priceListId: priceListId ?? null,
          reason: null,
          actor: this.adminActor(actor),
        });
        await moveApplication(tx, { jobs: this.jobs }, row, 'approve', {
          actor: this.applicationActor(actor),
          approvedPriceListId: effectiveListId,
        });
      });
    } catch (error) {
      throw coded(error);
    }
    return this.detail(id);
  }

  /** MA6: the direct grant; an open application of the customer is closed as approved. */
  async grant(
    customerId: string,
    input: GrantMerchant,
    actor: MerchantActor,
  ): Promise<AdminCustomer> {
    if (!isUuid(customerId)) throw refusals.notFound('customer');
    try {
      await this.db.transaction(async (tx) => {
        const customer = await lockCustomer(tx, customerId);
        const open = await lockOpenApplication(tx, customerId);
        const { effectiveListId } = await grantMerchant(tx, { jobs: this.jobs }, customer, {
          tradeName: input.tradeName,
          governorate: input.governorate,
          city: input.city,
          applicationId: null,
          termsVersionId: null,
          priceListId: input.priceListId ?? null,
          reason: input.reason,
          actor: this.adminActor(actor),
        });
        if (open) {
          await moveApplication(tx, { jobs: this.jobs }, open, 'grant', {
            actor: this.applicationActor(actor),
            approvedPriceListId: effectiveListId,
          });
        }
      });
    } catch (error) {
      throw coded(error);
    }
    return this.customers.profile(customerId);
  }

  /** MA7. */
  async revoke(customerId: string, reason: string, actor: MerchantActor): Promise<AdminCustomer> {
    if (!isUuid(customerId)) throw refusals.notFound('customer');
    try {
      await this.db.transaction(async (tx) =>
        revokeMerchant(tx, { jobs: this.jobs }, await lockCustomer(tx, customerId), {
          reason,
          actor: this.adminActor(actor),
        }),
      );
    } catch (error) {
      throw coded(error);
    }
    return this.customers.profile(customerId);
  }

  /** `GET /api/admin/merchants`. */
  async merchants(query: MerchantListQuery): Promise<AdminMerchantPage> {
    const rows = await merchantPage(this.db, {
      q: query.q ?? null,
      listId: query.listId ?? null,
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit,
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        customerId: row.customerId,
        name: row.name,
        email: row.email,
        tradeName: row.tradeName,
        governorate: row.governorate,
        city: row.city,
        priceList: { id: row.listId, name: row.listName },
        priceKind: priceKindOf(row.listKind),
        termsAccepted: row.termsAccepted,
        frozen: row.frozen,
        grantedAt: row.grantedAt.toISOString(),
        sales30dUsdUnits: row.sales30d,
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: last.cursorAt, id: last.customerId })
          : null,
    };
  }

  /** `GET /api/admin/merchant-settings`. */
  async settings(): Promise<MerchantSettings> {
    return settingsView(await currentMerchantSettings(this.db), await this.minimumDeposit());
  }

  /** `PUT /api/admin/merchant-settings`: a new version, both limits at least the minimums. */
  async saveSettings(
    input: MerchantSettingsInput,
    actor: MerchantActor,
  ): Promise<MerchantSettings> {
    const minimum = await this.minimumDeposit();
    const below = merchantLimitsBelowMinimum(input, minimum);
    if (below.length > 0) {
      throw refusals.invalid(below[0] as string, 'Below the deposit minimum');
    }
    const row = await this.db.transaction(async (tx) => {
      const before = await currentMerchantSettings(tx);
      const [saved] = await tx
        .insert(merchantSettings)
        .values({ id: newId(), ...input, adminId: actor.adminId })
        .returning();
      await recordAudit(tx, {
        action: 'merchant_settings.changed',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'merchant_settings',
        entityId: (saved as { id: string }).id,
        ipAddress: actor.meta.ipAddress,
        userAgent: actor.meta.userAgent,
        details: {
          before: {
            perDepositUsdUnits: before.perDepositUsdUnits,
            dailyDepositUsdUnits: before.dailyDepositUsdUnits,
            ordersPerTenMinutes: before.ordersPerTenMinutes,
            reapplyWaitDays: before.reapplyWaitDays,
            infoExpiryDays: before.infoExpiryDays,
          },
          after: input,
        },
      });
      return saved as typeof before;
    });
    return settingsView(row, minimum);
  }

  /** MA8: the dashboard's `merchant_applications_waiting`, with the oldest submission. */
  async waiting(): Promise<{ count: number; oldestAt: Date | null }> {
    const [row] = await this.db
      .select({ count: count(), oldestAt: min(merchantApplications.submittedAt) })
      .from(merchantApplications)
      .where(eq(merchantApplications.status, 'under_review'));
    return { count: row?.count ?? 0, oldestAt: row?.oldestAt ?? null };
  }

  /** The highest of the Sham Cash and USDT minimums (data: both limits reach it). */
  private async minimumDeposit(): Promise<number> {
    const current = (await this.depositSettings.current()) ?? DEPOSIT_SETTINGS_DEFAULTS;
    return Math.max(current.minDepositUsdUnits, current.usdtMinDepositUsdUnits);
  }

  private async find(id: string): Promise<MerchantApplicationRow> {
    if (!isUuid(id)) throw refusals.notFound();
    const [row] = await this.db
      .select()
      .from(merchantApplications)
      .where(eq(merchantApplications.id, id))
      .orderBy(asc(merchantApplications.id));
    if (!row) throw refusals.notFound();
    return row;
  }

  private adminActor(actor: MerchantActor): AdminActor {
    return {
      adminId: actor.adminId,
      ipAddress: actor.meta.ipAddress,
      userAgent: actor.meta.userAgent,
    };
  }

  private applicationActor(actor: MerchantActor) {
    return { kind: 'admin' as const, ...this.adminActor(actor) };
  }
}
