import { Inject, Injectable } from '@nestjs/common';
import type { AuditEntry, AuditListQuery, AuditPage } from '@vertex-digital/contracts';
import { auditEntries, type Database } from '@vertex-digital/db';
import { and, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AdminAuthService } from '../admin/index.js';
import { AuthService } from '../auth/index.js';

/**
 * The audit log (S01 rule A4): newest first, filtered, with the actors' names. Entries are written
 * by `recordAudit` in each module's transactions; this module only reads them.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly customers: AuthService,
    private readonly admins: AdminAuthService,
  ) {}

  async list(query: AuditListQuery): Promise<AuditPage> {
    const filters: (SQL | undefined)[] = [
      query.actorKind ? eq(auditEntries.actorKind, query.actorKind) : undefined,
      query.actorId ? eq(auditEntries.actorId, query.actorId) : undefined,
      query.action ? eq(auditEntries.action, query.action) : undefined,
      query.entityType ? eq(auditEntries.entityType, query.entityType) : undefined,
      query.entityId ? eq(auditEntries.entityId, query.entityId) : undefined,
      query.from ? gte(auditEntries.occurredAt, new Date(query.from)) : undefined,
      query.to ? lte(auditEntries.occurredAt, new Date(query.to)) : undefined,
    ];
    if (query.cursor) {
      const after = decodeCursor(query.cursor);
      filters.push(
        or(
          lt(auditEntries.occurredAt, after.at),
          and(eq(auditEntries.occurredAt, after.at), lt(auditEntries.id, after.id)),
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(auditEntries)
      .where(and(...filters))
      .orderBy(desc(auditEntries.occurredAt), desc(auditEntries.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.occurredAt, id: row.id }));

    const idsOf = (kind: 'admin' | 'customer') => [
      ...new Set(
        page.items
          .filter((row) => row.actorKind === kind && row.actorId)
          .map((row) => row.actorId as string),
      ),
    ];
    const [adminNames, customerNames] = await Promise.all([
      this.admins.namesOf(idsOf('admin')),
      this.customers.namesOf(idsOf('customer')),
    ]);
    const nameOf = (row: (typeof rows)[number]) => {
      if (!row.actorId) return null;
      const names = row.actorKind === 'admin' ? adminNames : customerNames;
      return names.get(row.actorId) ?? null;
    };

    return {
      items: page.items.map(
        (row): AuditEntry => ({
          id: row.id,
          occurredAt: row.occurredAt.toISOString(),
          actorKind: row.actorKind,
          actorId: row.actorId,
          actorName: nameOf(row),
          channel: row.channel,
          action: row.action as AuditEntry['action'],
          entityType: row.entityType as AuditEntry['entityType'],
          entityId: row.entityId,
          reason: row.reason,
          details: row.details as Record<string, unknown>,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }
}
