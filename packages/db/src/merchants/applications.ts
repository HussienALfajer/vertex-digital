import {
  APPLICATION_ACTION_EVENTS,
  type ApplicationAction,
  type AuditChannel,
  applicationTransition,
  type MerchantApplicationStatus,
  type MerchantApplicationValues,
  reapplyAvailableAt,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, lte, notInArray, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Database, Executor, Transaction } from '../client.js';
import { CustomerError } from '../customers/state.js';
import { newId } from '../id.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import {
  contentPageVersions,
  customers,
  merchantApplicationEvents,
  merchantApplications,
} from '../schema/index.js';
import { currentMerchantSettings } from './accounts.js';

/*
 * Merchant applications (S20 MA1–MA4): the one way an application changes status, shared by the
 * API (the customer and the admin) and the worker (the expiry). Each move is checked against the
 * contracts' `applicationTransition` with the application locked by the caller, and writes the
 * row, its timeline event, the audit entry and the customer's notification in one transaction.
 */

export type MerchantApplicationRow = typeof merchantApplications.$inferSelect;

/** Who moves an application, as the audit entry records it. */
export type ApplicationActor =
  | { kind: 'customer'; customerId: string; ipAddress: string | null; userAgent: string | null }
  | { kind: 'admin'; adminId: string; ipAddress: string | null; userAgent: string | null }
  | { kind: 'system' };

/** The form's columns from a parsed input (MA2), for an insert or a resubmission. */
export function applicationColumns(form: MerchantApplicationValues) {
  return {
    tradeName: form.tradeName,
    activity: form.activity,
    activityOther: form.activityOther,
    yearsInBusiness: form.yearsInBusiness,
    governorate: form.governorate,
    city: form.city,
    streetAddress: form.streetAddress,
    whatsapp: form.whatsapp,
    telegramUsername: form.telegramUsername,
    monthlyVolume: form.monthlyVolume,
    productInterests: form.productInterests,
    salesChannels: form.salesChannels,
    shopPhotoFileId: form.shopPhotoFileId,
    shopLink: form.shopLink,
    termsVersionId: form.termsVersionId,
    heardFrom: form.heardFrom,
  };
}

/** The application `FOR UPDATE`, or null. */
export async function lockApplication(
  tx: Transaction,
  applicationId: string,
): Promise<MerchantApplicationRow | null> {
  const [row] = await tx
    .select()
    .from(merchantApplications)
    .where(eq(merchantApplications.id, applicationId))
    .for('update');
  return row ?? null;
}

/** The customer's open application `FOR UPDATE` (MA6 closes it), or null. */
export async function lockOpenApplication(
  tx: Transaction,
  customerId: string,
): Promise<MerchantApplicationRow | null> {
  const [row] = await tx
    .select()
    .from(merchantApplications)
    .where(
      and(
        eq(merchantApplications.customerId, customerId),
        sql`${merchantApplications.status} in ('under_review', 'info_requested')`,
      ),
    )
    .for('update');
  return row ?? null;
}

/** The customer's newest application, or null. */
export async function latestApplication(
  db: Executor,
  customerId: string,
): Promise<MerchantApplicationRow | null> {
  const [row] = await db
    .select()
    .from(merchantApplications)
    .where(eq(merchantApplications.customerId, customerId))
    .orderBy(desc(merchantApplications.createdAt), desc(merchantApplications.id))
    .limit(1);
  return row ?? null;
}

export interface MoveInput {
  actor: ApplicationActor;
  /** The admin's message or reason (`request_info`, `reject`), shown to the customer. */
  message?: string;
  /** `resubmit`: the edited form. */
  form?: MerchantApplicationValues;
  /** `approve`, `grant`: the list the merchant pays. */
  approvedPriceListId?: string;
}

/**
 * MA4: moves the locked application by `action` (`APPLICATION_STATE_INVALID` with the status
 * when the table refuses), writing its event, audit entry and notification. `approve` and `grant`
 * leave the account to `grantMerchant`, called by the caller in the same transaction.
 */
export async function moveApplication(
  tx: Transaction,
  context: { jobs: JobSender },
  application: MerchantApplicationRow,
  action: ApplicationAction,
  input: MoveInput,
): Promise<MerchantApplicationRow> {
  const next = applicationTransition(application.status, action);
  if (next === null) {
    throw new CustomerError('APPLICATION_STATE_INVALID', 'The application cannot move so', {
      status: application.status,
    });
  }
  const now = sql`now()`;
  const changes: Partial<typeof merchantApplications.$inferInsert> = { status: next };
  switch (action) {
    case 'request_info':
      Object.assign(changes, { adminMessage: input.message, infoRequestedAt: now });
      break;
    case 'resubmit':
      Object.assign(changes, { ...applicationColumns(input.form as MerchantApplicationValues) });
      break;
    case 'reject':
      Object.assign(changes, { adminMessage: input.message, decidedAt: now });
      break;
    case 'approve':
    case 'grant':
      Object.assign(changes, { approvedPriceListId: input.approvedPriceListId, decidedAt: now });
      break;
    case 'withdraw':
    case 'expire':
      Object.assign(changes, { decidedAt: now });
      break;
  }
  const [row] = await tx
    .update(merchantApplications)
    .set(changes)
    .where(
      and(
        eq(merchantApplications.id, application.id),
        eq(merchantApplications.status, application.status),
      ),
    )
    .returning();
  if (!row) throw new Error(`Merchant application ${application.id} changed under its lock`);
  const event = APPLICATION_ACTION_EVENTS[action];
  await tx.insert(merchantApplicationEvents).values({
    id: newId(),
    applicationId: row.id,
    event,
    message: action === 'request_info' || action === 'reject' ? (input.message ?? null) : null,
  });
  await auditMove(tx, row, action, input);
  await notifyMove(tx, context, row, action, input);
  return row;
}

const CHANNELS: Record<ApplicationActor['kind'], AuditChannel> = {
  customer: 'store',
  admin: 'admin',
  system: 'worker',
};

async function auditMove(
  tx: Transaction,
  row: MerchantApplicationRow,
  action: ApplicationAction,
  input: MoveInput,
): Promise<void> {
  const actor = input.actor;
  const base = {
    actorKind: actor.kind,
    actorId:
      actor.kind === 'customer' ? actor.customerId : actor.kind === 'admin' ? actor.adminId : null,
    channel: CHANNELS[actor.kind],
    entityType: 'merchant_application' as const,
    entityId: row.id,
    reason: input.message ?? null,
    ipAddress: actor.kind === 'system' ? null : actor.ipAddress,
    userAgent: actor.kind === 'system' ? null : actor.userAgent,
  };
  const customerId = row.customerId;
  switch (action) {
    case 'resubmit':
      await recordAudit(tx, {
        ...base,
        action: 'merchant_application.resubmitted',
        details: {
          customerId,
          termsVersion: await termsVersionNumber(tx, row.termsVersionId),
          fields: Object.keys(applicationColumns(input.form as MerchantApplicationValues)),
        },
      });
      return;
    case 'approve':
    case 'grant':
      await recordAudit(tx, {
        ...base,
        action: 'merchant_application.approved',
        details: { customerId, priceListId: row.approvedPriceListId as string },
      });
      return;
    case 'request_info':
      await recordAudit(tx, {
        ...base,
        action: 'merchant_application.info_requested',
        details: { customerId },
      });
      return;
    case 'reject':
      await recordAudit(tx, {
        ...base,
        action: 'merchant_application.rejected',
        details: { customerId },
      });
      return;
    case 'withdraw':
      await recordAudit(tx, {
        ...base,
        action: 'merchant_application.withdrawn',
        details: { customerId },
      });
      return;
    case 'expire':
      await recordAudit(tx, {
        ...base,
        action: 'merchant_application.expired',
        details: { customerId },
      });
      return;
  }
}

async function notifyMove(
  tx: Transaction,
  context: { jobs: JobSender },
  row: MerchantApplicationRow,
  action: ApplicationAction,
  input: MoveInput,
): Promise<void> {
  const customerId = row.customerId;
  if (action === 'request_info') {
    await notifyCustomer(tx, context.jobs, {
      customerId,
      event: 'merchant_info_requested',
      params: { applicationId: row.id, message: input.message as string },
    });
  } else if (action === 'reject') {
    const settings = await currentMerchantSettings(tx);
    await notifyCustomer(tx, context.jobs, {
      customerId,
      event: 'merchant_rejected',
      params: {
        applicationId: row.id,
        reason: input.message as string,
        availableAt: reapplyAvailableAt(
          row.decidedAt as Date,
          settings.reapplyWaitDays,
        ).toISOString(),
      },
    });
  } else if (action === 'expire') {
    await notifyCustomer(tx, context.jobs, {
      customerId,
      event: 'merchant_application_expired',
      params: { applicationId: row.id },
    });
  }
}

/** The version number of a `merchant_terms` version, for audit details. */
export async function termsVersionNumber(db: Executor, versionId: string): Promise<number> {
  const [row] = await db
    .select({ version: contentPageVersions.version })
    .from(contentPageVersions)
    .where(eq(contentPageVersions.id, versionId));
  if (!row) throw new Error(`No content page version ${versionId}`);
  return row.version;
}

const applicantQuery = (db: Executor, customerId: string) =>
  db
    .select({
      accountType: customers.accountType,
      frozenAt: customers.frozenAt,
      archivedAt: customers.archivedAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId));

/** MA1: what the refusals read of the applicant; null for an unknown customer. */
export async function applicant(db: Executor, customerId: string) {
  const [row] = await applicantQuery(db, customerId);
  return row ?? null;
}

/**
 * MA1: the applicant `FOR SHARE` in a submission (a grant takes it `FOR NO KEY UPDATE`, so a
 * submission and a grant never interleave).
 */
export async function lockApplicant(tx: Transaction, customerId: string) {
  const [row] = await applicantQuery(tx, customerId).for('share');
  return row ?? null;
}

/**
 * The worker's `merchants.expire-applications` (MA4, edge case 14): applications waiting for
 * information longer than `info_expiry_days` from `info_requested_at`, each in its own
 * transaction, `FOR UPDATE SKIP LOCKED`; the status check makes a second run a no-op. One that
 * fails is passed over for the rest of the run, so it never holds the later ones back, and the
 * run then throws naming it (audit A06-29); the next run tries it again.
 */
export async function expireMerchantApplications(
  db: Database,
  context: { jobs: JobSender },
  now: Date = new Date(),
): Promise<number> {
  const settings = await currentMerchantSettings(db);
  const cutoff = sql`${now.toISOString()}::timestamptz - make_interval(days => ${settings.infoExpiryDays})`;
  let expired = 0;
  const failed: string[] = [];
  for (;;) {
    let current: string | null = null;
    try {
      const moved = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(merchantApplications)
          .where(
            and(
              eq(merchantApplications.status, 'info_requested' satisfies MerchantApplicationStatus),
              lte(merchantApplications.infoRequestedAt, cutoff),
              failed.length > 0 ? notInArray(merchantApplications.id, failed) : undefined,
            ),
          )
          .orderBy(asc(merchantApplications.infoRequestedAt), asc(merchantApplications.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return false;
        current = row.id;
        await moveApplication(tx, context, row, 'expire', { actor: { kind: 'system' } });
        return true;
      });
      if (!moved) break;
      expired += 1;
    } catch (error) {
      if (current === null) throw error;
      failed.push(current);
    }
  }
  if (failed.length > 0) {
    throw new Error(`Merchant applications not expired: ${failed.join(', ')}`);
  }
  return expired;
}
