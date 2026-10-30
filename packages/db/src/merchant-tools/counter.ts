import type { ProductKind } from '@vertex-digital/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import {
  catalogInputFields,
  catalogProducts,
  merchantApplications,
  merchantProfiles,
  merchantReceiptSettings,
  orders,
} from '../schema/index.js';
import { paidAsMerchant } from './reads.js';

/*
 * The counter tools' rows (S21 F32–F35): what a bulk list is parsed against, the receipt settings
 * with their defaults, and the merchant's own order whose selling price they set.
 */

export interface BulkPack {
  id: string;
  nameAr: string;
  gameAmount: number | null;
  kind: ProductKind;
  maxQuantity: number;
}

/** BK1 (`BulkGame` of the contracts): a game's unarchived field keys in their order and its unarchived packs. */
export async function bulkGame(
  db: Executor,
  gameId: string,
): Promise<{ fieldKeys: string[]; packs: BulkPack[] }> {
  const fields = await db
    .select({ key: catalogInputFields.key })
    .from(catalogInputFields)
    .where(and(eq(catalogInputFields.gameId, gameId), isNull(catalogInputFields.archivedAt)))
    .orderBy(asc(catalogInputFields.sortOrder));
  const packs = await db
    .select({
      id: catalogProducts.id,
      nameAr: catalogProducts.nameAr,
      gameAmount: catalogProducts.gameAmount,
      kind: catalogProducts.kind,
      maxQuantity: catalogProducts.maxQuantity,
    })
    .from(catalogProducts)
    .where(and(eq(catalogProducts.gameId, gameId), isNull(catalogProducts.archivedAt)))
    .orderBy(asc(catalogProducts.sortOrder), asc(catalogProducts.createdAt));
  return { fieldKeys: fields.map((field) => field.key), packs };
}

export interface ReceiptSettingsRow {
  tradeName: string;
  showWhatsapp: boolean;
  whatsapp: string | null;
  logoFileId: string | null;
  /** S23 RC1. */
  welcomeText: string | null;
}

/**
 * BR3: the merchant's receipt settings: the approved trade name, and the saved settings, or the
 * defaults (the application's WhatsApp, not shown, no logo). Null without a merchant profile.
 */
export async function receiptSettingsOf(
  db: Executor,
  customerId: string,
): Promise<ReceiptSettingsRow | null> {
  const [row] = await db
    .select({
      tradeName: merchantProfiles.tradeName,
      applicationWhatsapp: merchantApplications.whatsapp,
      saved: merchantReceiptSettings,
    })
    .from(merchantProfiles)
    .leftJoin(merchantApplications, eq(merchantApplications.id, merchantProfiles.applicationId))
    .leftJoin(
      merchantReceiptSettings,
      eq(merchantReceiptSettings.customerId, merchantProfiles.customerId),
    )
    .where(eq(merchantProfiles.customerId, customerId));
  if (!row) return null;
  return {
    tradeName: row.tradeName,
    showWhatsapp: row.saved?.showWhatsapp ?? false,
    whatsapp: row.saved ? row.saved.whatsapp : row.applicationWhatsapp,
    logoFileId: row.saved?.logoFileId ?? null,
    welcomeText: row.saved?.welcomeText ?? null,
  };
}

/** BR3: saves the merchant's receipt settings. */
export async function saveReceiptSettings(
  db: Executor,
  customerId: string,
  values: Omit<ReceiptSettingsRow, 'tradeName'>,
): Promise<void> {
  await db
    .insert(merchantReceiptSettings)
    .values({ customerId, ...values })
    .onConflictDoUpdate({ target: merchantReceiptSettings.customerId, set: values });
}

/**
 * BR3: the admin removes a merchant's logo in the caller's transaction, the row locked; answers
 * the removed file's id, or null when there was none.
 */
export async function removeMerchantLogo(
  tx: Transaction,
  customerId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ logoFileId: merchantReceiptSettings.logoFileId })
    .from(merchantReceiptSettings)
    .where(eq(merchantReceiptSettings.customerId, customerId))
    .for('update');
  if (!row?.logoFileId) return null;
  await tx
    .update(merchantReceiptSettings)
    .set({ logoFileId: null })
    .where(eq(merchantReceiptSettings.customerId, customerId));
  return row.logoFileId;
}

/**
 * S23 RC1: the admin removes a merchant's welcome line in the caller's transaction, the row
 * locked; answers the removed line, or null when there was none.
 */
export async function removeWelcomeText(
  tx: Transaction,
  customerId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ welcomeText: merchantReceiptSettings.welcomeText })
    .from(merchantReceiptSettings)
    .where(eq(merchantReceiptSettings.customerId, customerId))
    .for('update');
  if (!row?.welcomeText) return null;
  await tx
    .update(merchantReceiptSettings)
    .set({ welcomeText: null })
    .where(eq(merchantReceiptSettings.customerId, customerId));
  return row.welcomeText;
}

/**
 * BR3: the uploaded logo made the merchant's logo in the caller's transaction, changing nothing
 * else (audit A06-39): a WhatsApp saved at the same time is kept. Without a saved row, the
 * defaults are written with it. False without a merchant profile.
 */
export async function setMerchantLogo(
  tx: Transaction,
  customerId: string,
  logoFileId: string,
): Promise<boolean> {
  const current = await receiptSettingsOf(tx, customerId);
  if (!current) return false;
  await tx
    .insert(merchantReceiptSettings)
    .values({
      customerId,
      showWhatsapp: current.showWhatsapp,
      whatsapp: current.whatsapp,
      logoFileId,
    })
    .onConflictDoUpdate({ target: merchantReceiptSettings.customerId, set: { logoFileId } });
  return true;
}

/**
 * SP5: the customer's own order, as `setOrderSale` reads it; null when it is not theirs, or not a
 * sale of the shop (audit A06-36: an owner-funded order, or one placed outside the grant).
 */
export async function ownOrderForSale(
  db: Executor,
  customerId: string,
  orderId: string,
): Promise<{ id: string; customerId: string; displayRateId: string | null } | null> {
  const [row] = await db
    .select({ id: orders.id, displayRateId: orders.displayRateId })
    .from(orders)
    .innerJoin(merchantProfiles, eq(merchantProfiles.customerId, orders.customerId))
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId), paidAsMerchant()));
  return row ? { ...row, customerId } : null;
}
