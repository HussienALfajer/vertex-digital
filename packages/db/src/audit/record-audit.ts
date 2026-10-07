import {
  AUDIT_DETAILS,
  type AuditAction,
  type AuditActorKind,
  type AuditChannel,
  type AuditDetails,
  type AuditEntityType,
} from '@vertex-digital/contracts';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { auditEntries } from '../schema/index.js';

export interface AuditInput<Action extends AuditAction> {
  action: Action;
  actorKind: AuditActorKind;
  /** The admin's or the customer's id; null for system and CLI entries. */
  actorId: string | null;
  channel: AuditChannel;
  entityType: AuditEntityType;
  entityId: string;
  details: AuditDetails<Action>;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Writes one audit entry inside the caller's transaction (S01 rule A1): the change and its entry
 * commit or roll back together. The details must match the action's shape in the contracts, which
 * never holds a secret; anything else is a bug and throws before the insert.
 */
export async function recordAudit<Action extends AuditAction>(
  tx: Transaction,
  entry: AuditInput<Action>,
): Promise<string> {
  const details = AUDIT_DETAILS[entry.action].parse(entry.details);
  const id = newId();
  await tx.insert(auditEntries).values({
    id,
    actorKind: entry.actorKind,
    actorId: entry.actorId,
    channel: entry.channel,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    reason: entry.reason ?? null,
    details,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  });
  return id;
}
