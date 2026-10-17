import type {
  AuditAction,
  AuditDetails,
  AuditEntityType,
  OptionMap,
  SupplierCode,
  SyncRun,
} from '@vertex-digital/contracts';
import {
  recordAudit,
  supplierOffers,
  type supplierSyncRuns,
  type suppliers,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq, inArray } from 'drizzle-orm';
import { violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { Actor } from '../catalog/index.js';

/*
 * Shared by the supplier services (S07): rows to responses, refusals with their codes, and the
 * audit entry of an admin change.
 */

export type SupplierRow = typeof suppliers.$inferSelect;
export type OfferRow = typeof supplierOffers.$inferSelect;
export type SyncRunRow = typeof supplierSyncRuns.$inferSelect;

export function toSyncRun(row: SyncRunRow, supplierCode: SupplierCode): SyncRun {
  return {
    id: row.id,
    supplierCode,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    offersSeen: row.offersSeen,
    offersNew: row.offersNew,
    costsChanged: row.costsChanged,
    offersMissing: row.offersMissing,
    reviewsOpened: row.reviewsOpened,
    productsRepriced: row.productsRepriced,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

export const refusals = {
  notFound: (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`),
  invalid: (message: string) => new CodedException(400, 'VALIDATION_FAILED', message),
  routeExists: () =>
    new CodedException(409, 'ROUTE_EXISTS', 'The product already has a route to this supplier'),
  offerMapped: (product: { productId: string; productNameAr: string }) =>
    new CodedException(409, 'OFFER_ALREADY_MAPPED', 'The offer serves another product', product),
  kindMismatch: () =>
    new CodedException(409, 'ROUTE_KIND_MISMATCH', "The offer's kind is not the product's"),
  fieldsUnmapped: (fields: string[]) =>
    new CodedException(409, 'ROUTE_FIELDS_UNMAPPED', 'Supplier fields are left unmapped', {
      fields,
    }),
  offerMissing: () =>
    new CodedException(409, 'OFFER_MISSING', 'The supplier no longer lists the offer'),
  offerUnsupported: () =>
    new CodedException(409, 'OFFER_UNSUPPORTED', 'The offer has fields this build cannot send'),
  offerIgnored: () => new CodedException(409, 'OFFER_IGNORED', 'The offer is ignored'),
  /** S16 MF3: supplier selects the option map cannot send from every option. */
  fieldOptionsDiffer: (fields: string[]) =>
    new CodedException(409, 'FIELD_OPTIONS_DIFFER', 'Select options lack a supplier value', {
      fields,
    }),
};

/** The refusal a route's unique index raised (rule RT1), or null for any other error. */
export function routeTakenRefusal(error: unknown): CodedException | null {
  const constraint = violatedConstraint(error);
  if (constraint === 'product_routes_product_id_supplier_id_live_idx')
    return refusals.routeExists();
  if (constraint === 'product_routes_offer_id_live_idx') {
    return new CodedException(409, 'OFFER_ALREADY_MAPPED', 'The offer serves another product');
  }
  return null;
}

/**
 * A batch's field and option maps limited to one offer's own fields (rules RT3, RT8, S16 MF2), all
 * of them when the offer does not publish its fields: a supplier is never sent a field it did not
 * ask for, and an adapter choosing among the account fields it is sent (WDGZone) never takes the
 * one another offer of the batch asked for.
 */
export function offerMaps(
  offer: Pick<OfferRow, 'requiredFields'>,
  maps: { fieldMap: Readonly<Record<string, string>>; optionMap: OptionMap },
): { fieldMap: Record<string, string>; optionMap: OptionMap } {
  const own = new Set(offer.requiredFields ?? Object.keys(maps.fieldMap));
  const mine = <Value>(map: Readonly<Record<string, Value>>) =>
    Object.fromEntries(Object.entries(map).filter(([key]) => own.has(key)));
  return { fieldMap: mine(maps.fieldMap), optionMap: mine(maps.optionMap) };
}

/**
 * The supplier's offers a write is about to route, read again inside its transaction `FOR KEY SHARE`, the
 * lock the route's foreign key takes anyway (a sync holding them `FOR NO KEY UPDATE` never waits
 * on it). An ignore locks its offer `FOR UPDATE`, then looks for a route: it either waits for this
 * write and finds its route, or is seen by it here (S16 SC6–SC8). Checked again by the caller.
 */
export async function lockOffersToRoute(
  tx: Transaction,
  supplierId: string,
  ids: readonly string[],
): Promise<Map<string, OfferRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(supplierOffers)
    .where(
      and(
        eq(supplierOffers.supplierId, supplierId),
        inArray(supplierOffers.id, [...new Set(ids)].sort()),
      ),
    )
    .orderBy(supplierOffers.id)
    .for('key share');
  return new Map(rows.map((row) => [row.id, row]));
}

/** The audit entry of an admin change to suppliers, routes or the policy, in its transaction. */
export function auditSuppliers<Action extends AuditAction>(
  tx: Transaction,
  actor: Actor,
  action: Action,
  entity: { type: AuditEntityType; id: string },
  details: AuditDetails<Action>,
): Promise<string> {
  return recordAudit(tx, {
    action,
    actorKind: 'admin',
    actorId: actor.adminId,
    channel: 'admin',
    entityType: entity.type,
    entityId: entity.id,
    ipAddress: actor.meta.ipAddress,
    userAgent: actor.meta.userAgent,
    details,
  });
}
