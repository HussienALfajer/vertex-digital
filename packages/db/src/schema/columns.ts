import { CURRENCIES } from '@vertex-digital/contracts';
import { bigint, customType, pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';
import { newId } from '../id.js';

/*
 * Column building blocks shared by every schema file (ADR 0011). A business table is
 * `{ id: id(), ...fields, ...timestamps(), archivedAt: archivedAt() }`.
 */

/** Primary key: a UUIDv7 generated in the application. */
export const id = () => uuid('id').primaryKey().$defaultFn(newId);

/** Creation and last-update times, in UTC. */
export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Set when a business record is archived; business records are never hard-deleted. */
export const archivedAt = () => timestamp('archived_at', { withTimezone: true });

/** The currency of a money amount (ADR 0003), from the contracts list. */
export const currencyEnum = pgEnum('currency', CURRENCIES);

/**
 * A money amount in integer units (ADR 0003), as `<name>_units`: next to a `currency` column, or
 * in a name that fixes the currency (`price_usd_units`). The scale is `CURRENCY_SCALE`.
 */
export const amountUnits = (name: `${string}_units`) => bigint(name, { mode: 'number' });

/** SHA-256 digests: PostgreSQL `bytea`, a Node `Buffer`. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
