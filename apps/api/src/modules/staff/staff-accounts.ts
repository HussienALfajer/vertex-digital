import { randomBytes } from 'node:crypto';
import {
  type Database,
  newId,
  staffAccounts,
  staffSessions,
  staffTwoFactors,
  staffUsers,
} from '@vertex-digital/db';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';

/*
 * Staff account changes made outside the panel, for the command-line tools (ADR 0007): the first
 * owner, and the owner's TOTP reset on the server. Their audit entries arrive with the audit
 * table (F02).
 */

/** Serializes concurrent "first owner" runs: only one can find no owner and create one. */
const FIRST_OWNER_LOCK_ID = 7_140_302;

export class StaffAccountError extends Error {}

/**
 * Creates the first owner with a generated password, returned once. Refuses when an active owner
 * exists: later staff are created by the owner in the panel (F02). TOTP is enrolled at the first
 * sign-in; until then every staff route answers `TWO_FACTOR_REQUIRED`.
 */
export async function createFirstOwner(
  db: Database,
  input: { email: string; name: string },
): Promise<{ id: string; password: string }> {
  const email = input.email.trim().toLowerCase();
  const password = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(password);
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_OWNER_LOCK_ID})`);
    const [owner] = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(and(eq(staffUsers.role, 'owner'), isNull(staffUsers.archivedAt)));
    if (owner) throw new StaffAccountError('An active owner exists: add staff from the panel.');
    const [taken] = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(eq(staffUsers.email, email));
    if (taken) throw new StaffAccountError(`A staff account with ${email} exists.`);
    await tx.insert(staffUsers).values({ id, email, name: input.name.trim(), role: 'owner' });
    await tx.insert(staffAccounts).values({
      userId: id,
      accountId: id,
      providerId: 'credential',
      password: passwordHash,
    });
  });
  return { id, password };
}

/**
 * Removes a staff member's TOTP secret and backup codes after a lost device, and signs them out
 * everywhere. They enrol again at their next sign-in, as a new account does.
 */
export async function resetStaffTwoFactor(db: Database, email: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(eq(staffUsers.email, email.trim().toLowerCase()))
      .for('update');
    if (!member) throw new StaffAccountError(`No staff account with ${email}.`);
    await tx.delete(staffTwoFactors).where(eq(staffTwoFactors.userId, member.id));
    await tx.delete(staffSessions).where(eq(staffSessions.userId, member.id));
    await tx
      .update(staffUsers)
      .set({ twoFactorEnabled: false })
      .where(eq(staffUsers.id, member.id));
  });
}
