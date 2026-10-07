import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreatedTestCustomer,
  CursorQuery,
  TestCustomer,
  TestCustomerPage,
} from '@vertex-digital/contracts';
import {
  customerAccounts,
  customerSessions,
  customers,
  type Database,
  newId,
  recordAudit,
} from '@vertex-digital/db';
import { hashPassword } from 'better-auth/crypto';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { decodeCursor, pageOf } from '../../core/lists/cursor.js';

/** 24 random base64url characters (rules T1, T2, D6). */
const generatePassword = () => randomBytes(18).toString('base64url');

const columns = {
  id: customers.id,
  name: customers.name,
  email: customers.email,
  phone: customers.phone,
  createdAt: customers.createdAt,
};

const shape = (row: {
  id: string;
  name: string;
  email: string;
  phone: string;
  createdAt: Date;
}): TestCustomer => ({ ...row, createdAt: row.createdAt.toISOString() });

/**
 * Test customers (S01 rules T1–T4): created by the admin while registration is closed, verified at
 * once, flagged `is_test`; their generated passwords are shown once.
 */
@Injectable()
export class AuthTestCustomersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(query: CursorQuery): Promise<TestCustomerPage> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.db
      .select(columns)
      .from(customers)
      .where(
        and(
          eq(customers.isTest, true),
          after
            ? or(
                lt(customers.createdAt, after.at),
                and(eq(customers.createdAt, after.at), lt(customers.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(customers.createdAt), desc(customers.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.createdAt, id: row.id }));
    return { items: page.items.map(shape), nextCursor: page.nextCursor };
  }

  async create(
    adminId: string,
    input: { name: string; email: string; phone: string },
    meta: RequestMeta,
  ): Promise<CreatedTestCustomer> {
    const email = input.email.trim().toLowerCase();
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const id = newId();
    try {
      const [created] = await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(customers)
          .values({
            id,
            name: input.name,
            email,
            phone: input.phone,
            emailVerified: true,
            isTest: true,
          })
          .returning(columns);
        await tx.insert(customerAccounts).values({
          userId: id,
          accountId: id,
          providerId: 'credential',
          password: passwordHash,
        });
        await recordAudit(tx, {
          action: 'customer.test_created',
          ...this.byAdmin(adminId, id, meta),
          details: { name: input.name, email, phone: input.phone },
        });
        return inserted;
      });
      return { ...shape(created as Parameters<typeof shape>[0]), password };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CodedException(409, 'EMAIL_TAKEN', 'The email belongs to another account');
      }
      throw error;
    }
  }

  /** Rule T2: test customers only; a real customer answers 404. */
  async resetPassword(adminId: string, customerId: string, meta: RequestMeta) {
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.isTest, true)))
        .for('update');
      if (!customer) throw new CodedException(404, 'NOT_FOUND', 'No such test customer');
      await tx
        .update(customerAccounts)
        .set({ password: passwordHash })
        .where(
          and(
            eq(customerAccounts.userId, customerId),
            eq(customerAccounts.providerId, 'credential'),
          ),
        );
      const removed = await tx
        .delete(customerSessions)
        .where(eq(customerSessions.userId, customerId))
        .returning({ id: customerSessions.id });
      await recordAudit(tx, {
        action: 'customer.test_password_reset',
        ...this.byAdmin(adminId, customerId, meta),
        details: { count: removed.length },
      });
    });
    return { password };
  }

  private byAdmin(adminId: string, customerId: string, meta: RequestMeta) {
    return {
      actorKind: 'admin',
      actorId: adminId,
      channel: 'admin',
      entityType: 'customer',
      entityId: customerId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}
