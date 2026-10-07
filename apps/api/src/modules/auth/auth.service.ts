import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { customers, type Database } from '@vertex-digital/db';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { inArray } from 'drizzle-orm';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { AltchaService } from '../../core/altcha/altcha.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
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
}
