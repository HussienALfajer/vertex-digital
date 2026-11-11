import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { EMAIL_CODE_TTL_SECONDS, SHOP_INVITATION_HOURS } from '@vertex-digital/contracts';
import { shopCustomerVerifications, type Transaction } from '@vertex-digital/db';
import { and, eq, gt } from 'drizzle-orm';

/*
 * The shop realm's email codes and invitation tokens (S26 CA1, CA2, CA4), in
 * `shop_customer_verifications`, as the customer realm's (`modules/auth/email-codes.ts`, S01 rule
 * C4): 6 digits, 10 minutes, void after 5 wrong tries, stored hashed, one per purpose, shop and
 * email. An invitation is a random token stored by its digest, valid 72 hours, used once.
 */

/**
 * `change-email` (CA8): keyed by the shop customer's id instead of an email (one pending change
 * per customer), its code bound to the new address it confirms.
 */
export type ShopCodePurpose = 'email-verification' | 'forget-password' | 'change-email';

export const MAX_WRONG_SHOP_CODE_ATTEMPTS = 5;

const identifierOf = (purpose: ShopCodePurpose, shopId: string, email: string) =>
  `${purpose}:${shopId}:${email}`;

const digest = (value: string) => createHash('sha256').update(value).digest();

/** A code bound to a value (the new email of a change): another value never matches it. */
const codeDigest = (code: string, binding: string | undefined) =>
  digest(binding === undefined ? code : `${code}:${binding}`);

/** A new code for the shop's email, replacing an earlier one of the same purpose. */
export async function issueShopCode(
  tx: Transaction,
  purpose: ShopCodePurpose,
  shopId: string,
  email: string,
  binding?: string,
): Promise<string> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await store(tx, identifierOf(purpose, shopId, email), codeDigest(code, binding));
  return code;
}

/** A code nobody receives, for the answers that must not tell whether an account exists (CA3). */
export async function issueShopDecoyCode(
  tx: Transaction,
  purpose: ShopCodePurpose,
  shopId: string,
  email: string,
): Promise<void> {
  await store(tx, identifierOf(purpose, shopId, email), digest(randomBytes(32).toString('hex')));
}

async function store(tx: Transaction, identifier: string, hash: Buffer): Promise<void> {
  const value = `${hash.toString('hex')}:0`;
  const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_SECONDS * 1000);
  await tx
    .insert(shopCustomerVerifications)
    .values({ identifier, value, expiresAt })
    .onConflictDoUpdate({
      target: shopCustomerVerifications.identifier,
      set: { value, expiresAt, createdAt: new Date() },
    });
}

/** Checks and consumes a code in the caller's transaction; a wrong try is counted. */
export async function checkShopCode(
  tx: Transaction,
  purpose: ShopCodePurpose,
  shopId: string,
  email: string,
  code: string,
  binding?: string,
): Promise<boolean> {
  const identifier = identifierOf(purpose, shopId, email);
  const [row] = await tx
    .select()
    .from(shopCustomerVerifications)
    .where(eq(shopCustomerVerifications.identifier, identifier))
    .for('update');
  if (!row) return false;
  const remove = () =>
    tx.delete(shopCustomerVerifications).where(eq(shopCustomerVerifications.id, row.id));
  const [stored = '', tries = '0'] = row.value.split(':');
  const attempts = Number.parseInt(tries, 10);
  if (row.expiresAt.getTime() < Date.now() || attempts >= MAX_WRONG_SHOP_CODE_ATTEMPTS) {
    await remove();
    return false;
  }
  const expected = Buffer.from(stored, 'hex');
  const given = codeDigest(code, binding);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    await tx
      .update(shopCustomerVerifications)
      .set({ value: `${stored}:${attempts + 1}` })
      .where(eq(shopCustomerVerifications.id, row.id));
    return false;
  }
  await remove();
  return true;
}

const invitationIdentifier = (token: string) => `invitation:${digest(token).toString('hex')}`;

/** CA1: a new invitation token for the shop customer, replacing any earlier one. */
export async function issueInvitation(
  tx: Transaction,
  shopCustomerId: string,
): Promise<{ token: string; expiresAt: Date }> {
  await tx
    .delete(shopCustomerVerifications)
    .where(eq(shopCustomerVerifications.value, `invitation-for:${shopCustomerId}`));
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SHOP_INVITATION_HOURS * 3600 * 1000);
  await tx.insert(shopCustomerVerifications).values({
    identifier: invitationIdentifier(token),
    value: `invitation-for:${shopCustomerId}`,
    expiresAt,
  });
  return { token, expiresAt };
}

/** CA1: the shop customer a live invitation names, consumed; null for any other token. */
export async function takeInvitation(tx: Transaction, token: string): Promise<string | null> {
  const [row] = await tx
    .delete(shopCustomerVerifications)
    .where(
      and(
        eq(shopCustomerVerifications.identifier, invitationIdentifier(token)),
        gt(shopCustomerVerifications.expiresAt, new Date()),
      ),
    )
    .returning({ value: shopCustomerVerifications.value });
  return row?.value.startsWith('invitation-for:')
    ? row.value.slice('invitation-for:'.length)
    : null;
}
