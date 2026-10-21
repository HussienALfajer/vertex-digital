import { applicant, type Database } from '@vertex-digital/db';
import { CodedException } from '../../core/errors/index.js';

export const refusals = {
  notMerchant: () => new CodedException(403, 'NOT_MERCHANT', 'The account is not a merchant'),
  frozen: () => new CodedException(403, 'ACCOUNT_FROZEN', 'The account is frozen'),
  notFound: (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`),
  invalid: (path: string, message: string) =>
    new CodedException(400, 'VALIDATION_FAILED', message, [{ path: [path], message }]),
};

/** S21 MA1: a merchant's account; `write` refuses a frozen one. */
export async function requireMerchant(
  db: Database,
  customerId: string,
  write = false,
): Promise<void> {
  const person = await applicant(db, customerId);
  if (person?.accountType !== 'merchant') throw refusals.notMerchant();
  if (write && (person.frozenAt !== null || person.archivedAt !== null)) {
    throw refusals.frozen();
  }
}
