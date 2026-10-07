import { randomBytes } from 'node:crypto';
import {
  adminAccounts,
  adminSessions,
  adminTwoFactors,
  adminUsers,
  type Database,
  newId,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';

/*
 * Admin account changes made on the server, for the command-line tools (ADR 0016): creating the
 * one admin account, and resetting its password or TOTP. Each run writes an audit entry in its
 * transaction (actor `cli`).
 */

/** Serializes concurrent `admin:create` runs: only one can find no admin and create one. */
const CREATE_ADMIN_LOCK_ID = 7_140_302;

export class AdminAccountError extends Error {}

/** 24 random base64url characters (rule D6). */
const generatePassword = () => randomBytes(18).toString('base64url');

const byCli = (adminId: string) =>
  ({
    actorKind: 'cli',
    actorId: null,
    channel: 'cli',
    entityType: 'admin_user',
    entityId: adminId,
  }) as const;

/**
 * Creates the admin account with a generated password, returned once (rule D1). Refuses when an
 * admin exists: there is only one, and the database refuses a second row too. The password must
 * be changed at the first sign-in, then TOTP enrolled.
 */
export async function createAdmin(
  db: Database,
  input: { email: string; name: string },
): Promise<{ id: string; password: string }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CREATE_ADMIN_LOCK_ID})`);
    const [existing] = await tx.select({ id: adminUsers.id }).from(adminUsers);
    if (existing) throw new AdminAccountError('An admin account exists: there is only one.');
    await tx.insert(adminUsers).values({ id, email, name, mustChangePassword: true });
    await tx.insert(adminAccounts).values({
      userId: id,
      accountId: id,
      providerId: 'credential',
      password: passwordHash,
    });
    await recordAudit(tx, { action: 'admin.created', ...byCli(id), details: { name, email } });
  });
  return { id, password };
}

async function lockAdmin(tx: Transaction, email: string): Promise<string> {
  const [admin] = await tx
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.email, email.trim().toLowerCase()))
    .for('update');
  if (!admin) throw new AdminAccountError(`No admin account with ${email}.`);
  return admin.id;
}

async function signOutEverywhere(tx: Transaction, adminId: string): Promise<number> {
  const removed = await tx
    .delete(adminSessions)
    .where(eq(adminSessions.userId, adminId))
    .returning({ id: adminSessions.id });
  return removed.length;
}

/**
 * Sets a new generated password, returned once, to be changed at the next sign-in, and signs the
 * admin out everywhere; TOTP stays enrolled (rule D2).
 */
export async function resetAdminPassword(
  db: Database,
  email: string,
): Promise<{ password: string }> {
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const adminId = await lockAdmin(tx, email);
    await tx
      .update(adminAccounts)
      .set({ password: passwordHash })
      .where(and(eq(adminAccounts.userId, adminId), eq(adminAccounts.providerId, 'credential')));
    await tx.update(adminUsers).set({ mustChangePassword: true }).where(eq(adminUsers.id, adminId));
    const count = await signOutEverywhere(tx, adminId);
    await recordAudit(tx, {
      action: 'admin.password_reset',
      ...byCli(adminId),
      details: { count },
    });
  });
  return { password };
}

/**
 * Removes the admin's TOTP secret and backup codes after a lost device, and signs the admin out
 * everywhere (rule D3). The admin enrols again at the next sign-in, as a new account does.
 */
export async function resetAdminTwoFactor(db: Database, email: string): Promise<void> {
  await db.transaction(async (tx) => {
    const adminId = await lockAdmin(tx, email);
    await tx.delete(adminTwoFactors).where(eq(adminTwoFactors.userId, adminId));
    const count = await signOutEverywhere(tx, adminId);
    await tx.update(adminUsers).set({ twoFactorEnabled: false }).where(eq(adminUsers.id, adminId));
    await recordAudit(tx, {
      action: 'admin.two_factor_reset',
      ...byCli(adminId),
      details: { count },
    });
  });
}
