import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@vertex-digital/db';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { AltchaService } from '../../core/altcha/altcha.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { type AdminAuth, createAdminAuth } from './admin-auth.config.js';

/** The signed-in admin of a request, as the access guard sees them. */
export interface AdminIdentity {
  id: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  archived: boolean;
  sessionId: string;
}

/** Owns the admin Better Auth instance: its HTTP handler and session lookups. */
@Injectable()
export class AdminAuthService {
  readonly auth: AdminAuth;

  constructor(@Inject(DATABASE) db: Database, @Inject(ENV) env: Env, altcha: AltchaService) {
    this.auth = createAdminAuth(db, env, (header) => altcha.verify(header));
  }

  /** The Node handler mounted at `/api/admin/auth` (`app.setup.ts`). */
  handler() {
    return toNodeHandler(this.auth);
  }

  /** The admin of the request's admin session cookie, or null. */
  async adminOf(headers: IncomingHttpHeaders): Promise<AdminIdentity | null> {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session) return null;
    const { user } = session;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
      archived: Boolean(user.archivedAt),
      sessionId: session.session.id,
    };
  }
}
