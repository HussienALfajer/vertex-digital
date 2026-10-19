import { subscriptionAlert } from '@vertex-digital/contracts';
import {
  type JobSender,
  queueStoreRevalidate,
  queueTelegramMessage,
  repriceProducts,
  routedProductIds,
  suppliers,
  type Transaction,
} from '@vertex-digital/db';
import { eq } from 'drizzle-orm';

/** What a supplier's account says of its plan; a part left out keeps the stored value. */
export interface AccountRead {
  plan?: string;
  active: boolean;
  expiresAt?: Date | null;
  autoRenew?: boolean | null;
}

/**
 * S19 FC9, in the caller's transaction: the plan kept on the supplier's row, under its row lock.
 * The plan read of the balances job, and an order refused for an inactive plan (FC5), both come
 * here. The alerts (48 hours before the end, once per end; inactive; active again) and, when the
 * plan turns inactive or comes back, the repricing of the supplier's products, whose routes it
 * stops or starts.
 */
export async function recordAccount(
  tx: Transaction,
  jobs: JobSender,
  supplier: { id: string; code: (typeof suppliers.$inferSelect)['code']; nameAr: string },
  read: AccountRead,
  options: { now: Date; fakeEnabled: boolean },
): Promise<void> {
  const [row] = await tx
    .select({
      plan: suppliers.accountPlan,
      expiresAt: suppliers.accountPlanExpiresAt,
      autoRenew: suppliers.accountAutoRenew,
      active: suppliers.accountActive,
      alertedFor: suppliers.planExpiryAlertedFor,
    })
    .from(suppliers)
    .where(eq(suppliers.id, supplier.id))
    .for('update');
  if (!row) return;
  const plan = read.plan?.trim().slice(0, 32) || row.plan || 'unknown';
  const expiresAt = read.expiresAt === undefined ? row.expiresAt : read.expiresAt;
  const autoRenew = read.autoRenew === undefined ? row.autoRenew : read.autoRenew;
  const alert = subscriptionAlert({
    previousActive: row.active,
    active: read.active,
    expiresAt,
    alertedFor: row.alertedFor,
    now: options.now,
  });
  await tx
    .update(suppliers)
    .set({
      accountPlan: plan,
      accountPlanExpiresAt: expiresAt,
      accountActive: read.active,
      accountAutoRenew: autoRenew,
      accountCheckedAt: options.now,
      ...(alert === 'expiring' && { planExpiryAlertedFor: expiresAt }),
      updatedAt: new Date(),
    })
    .where(eq(suppliers.id, supplier.id));
  if (alert === 'inactive' || alert === 'active') {
    await repriceProducts(tx, {
      productIds: await routedProductIds(tx, [supplier.code]),
      cause: 'route_change',
      context: { now: new Date(), fakeEnabled: options.fakeEnabled },
    });
    await queueStoreRevalidate(tx, jobs);
  }
  if (alert === null) return;
  await queueTelegramMessage(tx, jobs, {
    kind: 'supplier_subscription',
    params: {
      supplier: supplier.code,
      supplierNameAr: supplier.nameAr,
      reason: alert,
      plan,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
    dedupeKey:
      alert === 'expiring'
        ? `subscription:${supplier.code}:expiring:${expiresAt?.toISOString()}`
        : `subscription:${supplier.code}:${alert}:${options.now.toISOString()}`,
  });
}
