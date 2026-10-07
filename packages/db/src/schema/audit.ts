import { AUDIT_ACTOR_KINDS, AUDIT_CHANNELS } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id } from './columns.js';

/*
 * The audit log (ADR 0011, S01 rules A1–A4), owned by the api `audit` module and written only
 * through `recordAudit` (`src/audit`), in the transaction of the change it records. Append-only:
 * migration 0005 adds the trigger that refuses UPDATE, DELETE and TRUNCATE and leaves the app role
 * INSERT and SELECT only.
 */

export const auditActorKindEnum = pgEnum('audit_actor_kind', AUDIT_ACTOR_KINDS);

export const auditChannelEnum = pgEnum('audit_channel', AUDIT_CHANNELS);

export const auditEntries = pgTable(
  'audit_entries',
  {
    id: id(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorKind: auditActorKindEnum('actor_kind').notNull(),
    /** The admin's or the customer's id, by `actor_kind`; null for system and CLI entries. */
    actorId: uuid('actor_id'),
    channel: auditChannelEnum('channel').notNull(),
    /** `<entity>.<verb>` from `AUDIT_DETAILS` in the contracts. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    reason: text('reason'),
    /** Before and after of the changed fields; never a secret (contracts `AUDIT_DETAILS`). */
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('audit_entries_occurred_at_idx').on(table.occurredAt.desc(), table.id.desc()),
    index('audit_entries_actor_idx').on(table.actorKind, table.actorId, table.occurredAt.desc()),
    index('audit_entries_entity_idx').on(table.entityType, table.entityId, table.occurredAt.desc()),
    index('audit_entries_action_idx').on(table.action, table.occurredAt.desc()),
  ],
);
