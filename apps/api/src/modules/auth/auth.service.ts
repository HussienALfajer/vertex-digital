import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import type { CursorQuery, WalletCustomer } from '@vertex-digital/contracts';
import { customers, type Database } from '@vertex-digital/db';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { and, desc, eq, ilike, inArray, isNull, like, ne, or } from 'drizzle-orm';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { AltchaService } from '../../core/altcha/altcha.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { type CustomerAuth, createCustomerAuth } from './auth.config.js';
import { AuthAccountService } from './auth-account.service.js';

/** The signed-in customer of a request, as the access guard sees them. */
export interface CustomerIdentity {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  archived: boolean;
  sessionId: string;
}

/** A customer as the deposit screens show them (S03). */
export interface DepositCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  isTest: boolean;
  createdAt: Date;
  archived: boolean;
}

/** Owns the customer Better Auth instance: its HTTP handler and session lookups. */
@Injectable()
export class AuthService {
  readonly auth: CustomerAuth;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
    accounts: AuthAccountService,
    altcha: AltchaService,
  ) {
    this.auth = createCustomerAuth(db, env, accounts, (header) => altcha.verify(header));
  }

  /** The Node handler mounted at `/api/auth` (`app.setup.ts`). */
  handler() {
    return toNodeHandler(this.auth);
  }

  /** The customer of the request's session cookie, or null. */
  async customerOf(headers: IncomingHttpHeaders): Promise<CustomerIdentity | null> {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session) return null;
    const { user } = session;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      archived: Boolean(user.archivedAt),
      sessionId: session.session.id,
    };
  }

  /** Customers' names by id, for screens that show who did something (the audit log). */
  async namesOf(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** A customer as the admin wallet screens show them (S02), or null. */
  async walletCustomer(id: string): Promise<WalletCustomer | null> {
    const [row] = await this.db
      .select(walletCustomerColumns)
      .from(customers)
      .where(eq(customers.id, id));
    return row ?? null;
  }

  /** Customers by id for the deposit screens (S03). */
  async depositCustomers(ids: readonly string[]): Promise<Map<string, DepositCustomer>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        ...walletCustomerColumns,
        createdAt: customers.createdAt,
        archivedAt: customers.archivedAt,
      })
      .from(customers)
      .where(inArray(customers.id, [...ids]));
    return new Map(
      rows.map(({ archivedAt, ...row }) => [row.id, { ...row, archived: archivedAt !== null }]),
    );
  }

  /** Other customers, not archived, with the customer's phone (S03 rule FL5). */
  async sharingPhone(customerId: string): Promise<string[]> {
    const [customer] = await this.db
      .select({ phone: customers.phone })
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!customer) return [];
    const rows = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.phone, customer.phone),
          ne(customers.id, customerId),
          isNull(customers.archivedAt),
        ),
      )
      .orderBy(customers.createdAt)
      .limit(50);
    return rows.map((row) => row.id);
  }

  /** The customer's id by their email, case-insensitive (S08 `order:place`); null when none. */
  async customerIdByEmail(email: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, email.trim().toLowerCase()));
    return row?.id ?? null;
  }

  /** The customer's test flag (S08 rule R4, S09 rule PV2); false for an unknown id. */
  async isTestCustomer(customerId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ isTest: customers.isTest })
      .from(customers)
      .where(eq(customers.id, customerId));
    return row?.isTest ?? false;
  }

  /** Ids of customers whose email starts with `prefix`, case-insensitive (S03 deposit queue). */
  async idsByEmailPrefix(prefix: string): Promise<string[]> {
    const literal = prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(ilike(customers.email, `${literal}%`))
      .limit(100);
    return rows.map((row) => row.id);
  }

  /**
   * Customers by email or phone prefix, or part of the name, case-insensitive (S02 wallet search);
   * newest first, a cursor to load more. `q` is matched literally: `%` and `_` are not wildcards.
   */
  async searchCustomers(
    q: string,
    query: CursorQuery,
  ): Promise<{ items: WalletCustomer[]; nextCursor: string | null }> {
    const literal = q.replace(/[\\%_]/g, (char) => `\\${char}`);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.db
      .select({ ...walletCustomerColumns, cursorAt: cursorTime(customers.createdAt) })
      .from(customers)
      .where(
        and(
          or(
            ilike(customers.email, `${literal}%`),
            like(customers.phone, `${literal}%`),
            like(customers.phone, `+${literal}%`),
            ilike(customers.name, `%${literal}%`),
          ),
          cursor ? after(customers.createdAt, customers.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(customers.createdAt), desc(customers.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.id }));
    return {
      items: page.items.map(({ cursorAt: _, ...customer }) => customer),
      nextCursor: page.nextCursor,
    };
  }
}

const walletCustomerColumns = {
  id: customers.id,
  name: customers.name,
  email: customers.email,
  phone: customers.phone,
  isTest: customers.isTest,
};
