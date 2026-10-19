import { randomBytes } from 'node:crypto';
import {
  customerAccounts,
  customerSessions,
  customerSignIns,
  customers,
  type Database,
  newId,
} from '@vertex-digital/db';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';

/*
 * Customer accounts for the local development seed (`db:seed-local`), written as a sign-up and
 * its sign-ins would leave them, with the date the account joined. Never used by a request.
 */

export interface DevCustomer {
  name: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  isTest: boolean;
  joinedAt: Date;
  termsVersionId: string | null;
  privacyVersionId: string | null;
  /** One sign-in per device, a few hours apart from the day it joined. */
  signIns: { ipAddress: string; userAgent: string }[];
}

/** The customer's id, an existing account with the email kept as it is. */
export async function createDevCustomer(
  db: Database,
  input: DevCustomer,
  password: string,
): Promise<{ id: string; created: boolean }> {
  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, input.email));
  if (existing) return { id: existing.id, created: false };
  const id = newId();
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.insert(customers).values({
      id,
      name: input.name,
      email: input.email,
      phone: input.phone,
      emailVerified: input.emailVerified,
      isTest: input.isTest,
      termsVersionId: input.termsVersionId,
      privacyVersionId: input.privacyVersionId,
      createdAt: input.joinedAt,
      updatedAt: input.joinedAt,
    });
    await tx
      .insert(customerAccounts)
      .values({ userId: id, accountId: id, providerId: 'credential', password: passwordHash });
    for (const [index, signIn] of input.signIns.entries()) {
      await tx.insert(customerSignIns).values({
        customerId: id,
        ...signIn,
        createdAt: new Date(input.joinedAt.getTime() + index * 3 * 3_600_000),
      });
    }
  });
  return { id, created: true };
}

/** A week-long session on one device, as a sign-in opens (a push device belongs to one). */
export async function createDevSession(
  db: Database,
  customerId: string,
  device: { ipAddress: string; userAgent: string },
): Promise<string> {
  const id = newId();
  await db.insert(customerSessions).values({
    id,
    userId: customerId,
    token: randomBytes(24).toString('base64url'),
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    ...device,
  });
  return id;
}
