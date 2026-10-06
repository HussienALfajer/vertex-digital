import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@vertex-digital/db';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { type CustomerAuth, createCustomerAuth } from './auth.config.js';

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

  constructor(@Inject(DATABASE) db: Database, @Inject(ENV) env: Env) {
    this.auth = createCustomerAuth(db, env);
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
}
