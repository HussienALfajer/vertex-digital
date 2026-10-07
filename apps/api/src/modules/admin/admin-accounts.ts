import { randomBytes } from 'node:crypto';
import {
  adminAccounts,
  adminSessions,
  adminTwoFactors,
  adminUsers,
  type Database,
  newId,
} from '@vertex-digital/db';
import { hashPassword } from 'better-auth/crypto';
import { eq, sql } from 'drizzle-orm';

/*
 * Admin account changes made on the server, for the command-line tools (ADR 0016): creating the
 * one admin account and resetting its TOTP.
 */

/** Serializes concurrent `admin:create` runs: only one can find no admin and create one. */
const CREATE_ADMIN_LOCK_ID = 7_140_302;

export class AdminAccountError extends Error {}

/**
 * Creates the admin account with a generated password, returned once. Refuses when an admin
 * exists: there is only one (ADR 0016). TOTP is enrolled at the first sign-in; until then every
 * admin route answers `TWO_FACTOR_REQUIRED`.
 */
export async function createAdmin(
  db: Database,
  input: { email: string; name: string },
): Promise<{ id: string; password: string }> {
  const email = input.email.trim().toLowerCase();
  const password = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(password);
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CREATE_ADMIN_LOCK_ID})`);
    const [existing] = await tx.select({ id: adminUsers.id }).from(adminUsers);
    if (existing) throw new AdminAccountError('An admin account exists: there is only one.');
    await tx.insert(adminUsers).values({ id, email, name: input.name.trim() });
    await tx.insert(adminAccounts).values({
      userId: id,
      accountId: id,
      providerId: 'credential',
      password: passwordHash,
    });
  });
  return { id, password };
}

/**
 * Removes the admin's TOTP secret and backup codes after a lost device, and signs the admin out
 * everywhere. The admin enrols again at the next sign-in, as a new account does.
 */
export async function resetAdminTwoFactor(db: Database, email: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [admin] = await tx
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.email, email.trim().toLowerCase()))
      .for('update');
    if (!admin) throw new AdminAccountError(`No admin account with ${email}.`);
    await tx.delete(adminTwoFactors).where(eq(adminTwoFactors.userId, admin.id));
    await tx.delete(adminSessions).where(eq(adminSessions.userId, admin.id));
    await tx.update(adminUsers).set({ twoFactorEnabled: false }).where(eq(adminUsers.id, admin.id));
  });
}
