import { desc, eq, inArray } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { contentPageVersions, customers } from '../schema/index.js';

/*
 * The terms and privacy versions a customer accepted at sign-up (S14 TA2, TA3), read here so the
 * api `auth` and `customers` modules never read the content tables themselves.
 */

type Executor = Database | Transaction;

export interface AcceptedVersion {
  version: number;
  publishedAt: Date;
}

async function newestVersionId(tx: Executor, page: 'terms' | 'privacy') {
  const [row] = await tx
    .select({ id: contentPageVersions.id })
    .from(contentPageVersions)
    .where(eq(contentPageVersions.page, page))
    .orderBy(desc(contentPageVersions.version))
    .limit(1);
  return row?.id ?? null;
}

/** Rule TA2: the newest terms and privacy versions, read in the customer insert's transaction. */
export async function acceptedVersionsNow(
  tx: Transaction,
): Promise<{ termsVersionId: string | null; privacyVersionId: string | null }> {
  const [termsVersionId, privacyVersionId] = await Promise.all([
    newestVersionId(tx, 'terms'),
    newestVersionId(tx, 'privacy'),
  ]);
  return { termsVersionId, privacyVersionId };
}

/** Rule TA3: what the admin profile shows; null for a customer who signed up before publication. */
export async function customerAcceptedVersions(
  db: Executor,
  customerId: string,
): Promise<{ terms: AcceptedVersion | null; privacy: AcceptedVersion | null }> {
  const [customer] = await db
    .select({ terms: customers.termsVersionId, privacy: customers.privacyVersionId })
    .from(customers)
    .where(eq(customers.id, customerId));
  const ids = [customer?.terms, customer?.privacy].filter((id): id is string => id != null);
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: contentPageVersions.id,
            version: contentPageVersions.version,
            publishedAt: contentPageVersions.publishedAt,
          })
          .from(contentPageVersions)
          .where(inArray(contentPageVersions.id, ids));
  const find = (id: string | null | undefined) => {
    const row = rows.find((candidate) => candidate.id === id);
    return row ? { version: row.version, publishedAt: row.publishedAt } : null;
  };
  return { terms: find(customer?.terms), privacy: find(customer?.privacy) };
}
