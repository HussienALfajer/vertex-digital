import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { adminSessions, adminUsers, type Database } from '@vertex-digital/db';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { and, eq, inArray, lt } from 'drizzle-orm';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { AltchaService } from '../../core/altcha/altcha.service.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { type AdminAuth, createAdminAuth, isIdle } from './admin-auth.config.js';

/** The signed-in admin of a request, as the access guard sees them. */
export interface AdminIdentity {
  id: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  archived: boolean;
  sessionId: string;
  /** The last re-authentication on this session (rule D5). */
  reauthenticatedAt: Date | null;
}

/** Activity is written at most this often: one update a minute is enough for a 30-minute rule. */
const ACTIVITY_GRANULARITY_MS = 60 * 1000;

/** Owns the admin Better Auth instance: its HTTP handler and session lookups. */
@Injectable()
export class AdminAuthService {
  readonly auth: AdminAuth;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
    altcha: AltchaService,
  ) {
    this.auth = createAdminAuth(db, env, (header) => altcha.verify(header));
  }

  /** The Node handler mounted at `/api/admin/auth` (`app.setup.ts`). */
  handler() {
    return toNodeHandler(this.auth);
  }

  /**
   * The admin of the request's admin session cookie, or null. A session idle for 30 minutes is
   * deleted and answers `401 SESSION_IDLE_EXPIRED` (rule D4); otherwise, when `activity`, the
   * request counts as activity.
   */
  async adminOf(
    headers: IncomingHttpHeaders,
    { activity }: { activity: boolean },
  ): Promise<AdminIdentity | null> {
    const found = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!found) return null;
    const { user, session } = found;
    const now = Date.now();
    const lastActiveAt = new Date(session.lastActiveAt ?? session.createdAt);
    if (isIdle(lastActiveAt, now)) {
      await this.db.delete(adminSessions).where(eq(adminSessions.id, session.id));
      throw new CodedException(
        401,
        'SESSION_IDLE_EXPIRED',
        'The session ended after 30 minutes without activity',
      );
    }
    if (activity && now - lastActiveAt.getTime() > ACTIVITY_GRANULARITY_MS) {
      await this.db
        .update(adminSessions)
        .set({ lastActiveAt: new Date(now) })
        .where(
          and(
            eq(adminSessions.id, session.id),
            lt(adminSessions.lastActiveAt, new Date(now - ACTIVITY_GRANULARITY_MS)),
          ),
        );
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
      mustChangePassword: Boolean(user.mustChangePassword),
      archived: Boolean(user.archivedAt),
      sessionId: session.id,
      reauthenticatedAt: session.reauthenticatedAt ? new Date(session.reauthenticatedAt) : null,
    };
  }

  /** Admin names by id, for screens that show who did something (the audit log). */
  async namesOf(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: adminUsers.id, name: adminUsers.name })
      .from(adminUsers)
      .where(inArray(adminUsers.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
