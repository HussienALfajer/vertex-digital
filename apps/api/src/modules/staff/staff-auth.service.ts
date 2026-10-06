import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { type StaffRole, staffRoleSchema } from '@vertex-digital/contracts';
import type { Database } from '@vertex-digital/db';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { AltchaService } from '../../core/altcha/altcha.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { createStaffAuth, type StaffAuth } from './staff-auth.config.js';

/** The signed-in staff member of a request, as the access guard sees them. */
export interface StaffIdentity {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  twoFactorEnabled: boolean;
  archived: boolean;
  sessionId: string;
}

/** Owns the staff Better Auth instance: its HTTP handler and session lookups. */
@Injectable()
export class StaffAuthService {
  readonly auth: StaffAuth;

  constructor(@Inject(DATABASE) db: Database, @Inject(ENV) env: Env, altcha: AltchaService) {
    this.auth = createStaffAuth(db, env, (header) => altcha.verify(header));
  }

  /** The Node handler mounted at `/api/admin/auth` (`app.setup.ts`). */
  handler() {
    return toNodeHandler(this.auth);
  }

  /** The staff member of the request's staff session cookie, or null. */
  async staffOf(headers: IncomingHttpHeaders): Promise<StaffIdentity | null> {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session) return null;
    const { user } = session;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: staffRoleSchema.parse(user.role),
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
      archived: Boolean(user.archivedAt),
      sessionId: session.session.id,
    };
  }
}
