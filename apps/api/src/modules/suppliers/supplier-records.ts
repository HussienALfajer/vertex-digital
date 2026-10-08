import type {
  AuditAction,
  AuditDetails,
  AuditEntityType,
  SupplierCode,
  SyncRun,
} from '@vertex-digital/contracts';
import {
  recordAudit,
  type supplierOffers,
  type supplierSyncRuns,
  type suppliers,
  type Transaction,
} from '@vertex-digital/db';
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
