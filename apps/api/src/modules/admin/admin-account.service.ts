import { Inject, Injectable } from '@nestjs/common';
import {
  ADMIN_SESSION_RULES,
  type AdminChangePassword,
  type AdminSession,
  PASSWORD_EQUALS_EMAIL,
  passwordEqualsEmail,
  type Reauthenticate,
  type Reauthentication,
} from '@vertex-digital/contracts';
import {
  adminAccounts,
  adminSessions,
  adminUsers,
  type Database,
  recordAudit,
} from '@vertex-digital/db';
import { APIError } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { and, desc, eq, ne } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { AdminAuthService, type AdminIdentity } from './admin-auth.service.js';

/**
 * The admin's own account (S01 rules D1, D5, D7): the password change, re-authentication and own
 * sessions. Each change and its audit entry share one transaction.
 */
@Injectable()
export class AdminAccountService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly admins: AdminAuthService,
  ) {}

  /** Rules D1, D7: needs the current password; clears a pending change; other sessions end. */
  async changePassword(
    admin: AdminIdentity,
    input: AdminChangePassword,
    meta: RequestMeta,
  ): Promise<void> {
    await this.assertPassword(admin.id, input.currentPassword);
    if (passwordEqualsEmail(input.newPassword, admin.email)) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', [
        { path: ['newPassword'], message: PASSWORD_EQUALS_EMAIL },
      ]);
    }
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.transaction(async (tx) => {
      await tx
        .update(adminAccounts)
        .set({ password: passwordHash })
        .where(and(eq(adminAccounts.userId, admin.id), eq(adminAccounts.providerId, 'credential')));
      await tx
        .update(adminUsers)
        .set({ mustChangePassword: false })
        .where(eq(adminUsers.id, admin.id));
      const others = await tx
        .delete(adminSessions)
        .where(and(eq(adminSessions.userId, admin.id), ne(adminSessions.id, admin.sessionId)))
        .returning({ id: adminSessions.id });
      await recordAudit(tx, {
        action: 'admin.password_changed',
        ...this.byAdmin(admin.id, meta),
        details: { count: others.length },
      });
    });
  }

  /**
   * Rule D5: the password and a code of the authenticator app (no backup code) open sensitive
   * routes on this session for 5 minutes.
   */
  async reauthenticate(
    admin: AdminIdentity,
    input: Reauthenticate,
    headers: Parameters<typeof fromNodeHeaders>[0],
  ): Promise<Reauthentication> {
    await this.assertPassword(admin.id, input.password);
    try {
      // On a signed-in session the plugin only checks the code: no session or cookie changes.
      await this.admins.auth.api.verifyTOTP({
        body: { code: input.totpCode },
        headers: fromNodeHeaders(headers),
      });
    } catch (error) {
      if (error instanceof APIError) {
        throw new CodedException(400, 'INVALID_CODE', 'The code is wrong');
      }
      throw error;
    }
    const now = new Date();
    await this.db
      .update(adminSessions)
      .set({ reauthenticatedAt: now })
      .where(eq(adminSessions.id, admin.sessionId));
    return {
      reauthenticatedUntil: new Date(
        now.getTime() + ADMIN_SESSION_RULES.reauthenticationMs,
      ).toISOString(),
    };
  }

  async sessions(admin: AdminIdentity): Promise<AdminSession[]> {
    const rows = await this.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.userId, admin.id))
      .orderBy(desc(adminSessions.lastActiveAt));
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      lastActiveAt: row.lastActiveAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      current: row.id === admin.sessionId,
    }));
  }

  /** One of the admin's own sessions; any other id answers 404. */
  async revokeSession(admin: AdminIdentity, sessionId: string, meta: RequestMeta) {
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(adminSessions)
        .where(and(eq(adminSessions.id, sessionId), eq(adminSessions.userId, admin.id)))
        .returning({ id: adminSessions.id });
      if (removed.length === 0) throw new CodedException(404, 'NOT_FOUND', 'No such session');
      await recordAudit(tx, {
        action: 'admin.sessions_revoked',
        ...this.byAdmin(admin.id, meta),
        details: { count: removed.length },
      });
    });
  }

  private byAdmin(adminId: string, meta: RequestMeta) {
    return {
      actorKind: 'admin',
      actorId: adminId,
      channel: 'admin',
      entityType: 'admin_user',
      entityId: adminId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }

  private async assertPassword(adminId: string, password: string): Promise<void> {
    const [account] = await this.db
      .select({ password: adminAccounts.password })
      .from(adminAccounts)
      .where(and(eq(adminAccounts.userId, adminId), eq(adminAccounts.providerId, 'credential')));
    const valid = account?.password
      ? await verifyPassword({ hash: account.password, password })
      : false;
    if (!valid) throw new CodedException(400, 'INVALID_PASSWORD', 'The password is wrong');
  }
}
