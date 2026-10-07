import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { EMAIL_CODE_TTL_SECONDS } from '@vertex-digital/contracts';
import { customerVerifications, type Transaction } from '@vertex-digital/db';
import { eq } from 'drizzle-orm';

/*
 * Email codes (S01 rule C4): 6 digits, valid 10 minutes, void after 5 wrong tries, one per
 * purpose and subject, so a new code replaces the previous one. Stored hashed in
 * `customer_verifications`; the plain code only goes into the outbox row of its email.
 */

export type CodePurpose = 'email-verification' | 'forget-password' | 'change-email';

/** Wrong tries a code takes; the next try voids it, right or wrong. */
export const MAX_WRONG_CODE_ATTEMPTS = 5;

export type CodeCheck =
  | { ok: true }
  | { ok: false; code: 'INVALID_OTP' | 'OTP_EXPIRED' | 'TOO_MANY_ATTEMPTS' };

const identifierOf = (purpose: CodePurpose, subject: string) => `${purpose}-otp-${subject}`;

const hashOf = (code: string) => createHash('sha256').update(code).digest();

/** A new code for `subject` (an email, or `<customer id>:<new email>`), replacing any earlier one. */
export async function issueCode(
  tx: Transaction,
  purpose: CodePurpose,
  subject: string,
): Promise<string> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const value = `${hashOf(code).toString('hex')}:0`;
  const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_SECONDS * 1000);
  await tx
    .insert(customerVerifications)
    .values({ identifier: identifierOf(purpose, subject), value, expiresAt })
    .onConflictDoUpdate({
      target: customerVerifications.identifier,
      set: { value, expiresAt, createdAt: new Date() },
    });
  return code;
}

/**
 * Checks a code inside the caller's transaction, consuming it when right. A wrong try is counted
 * in the same transaction: the caller commits it before answering the error.
 */
export async function checkCode(
  tx: Transaction,
  purpose: CodePurpose,
  subject: string,
  code: string,
): Promise<CodeCheck> {
  const identifier = identifierOf(purpose, subject);
  const [row] = await tx
    .select()
    .from(customerVerifications)
    .where(eq(customerVerifications.identifier, identifier))
    .for('update');
  if (!row) return { ok: false, code: 'INVALID_OTP' };
  const remove = () => tx.delete(customerVerifications).where(eq(customerVerifications.id, row.id));
  if (row.expiresAt.getTime() < Date.now()) {
    await remove();
    return { ok: false, code: 'OTP_EXPIRED' };
  }
  const [storedHash = '', storedAttempts = '0'] = row.value.split(':');
  const attempts = Number.parseInt(storedAttempts, 10);
  if (attempts >= MAX_WRONG_CODE_ATTEMPTS) {
    await remove();
    return { ok: false, code: 'TOO_MANY_ATTEMPTS' };
  }
  const expected = Buffer.from(storedHash, 'hex');
  const given = hashOf(code);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    await tx
      .update(customerVerifications)
      .set({ value: `${storedHash}:${attempts + 1}` })
      .where(eq(customerVerifications.id, row.id));
    return { ok: false, code: 'INVALID_OTP' };
  }
  await remove();
  return { ok: true };
}
