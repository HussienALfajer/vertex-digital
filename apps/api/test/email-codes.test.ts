import { createDatabase, customerVerifications } from '@vertex-digital/db';
import { testDatabaseUrl } from '@vertex-digital/db/testing';
import { like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { checkCode, issueCode, issueDecoyCode } from '../src/modules/auth/email-codes.js';
import { uniqueEmail } from './helpers.js';

/*
 * Email codes (S01 rule C4) and their decoys: a decoy behaves like a code for tries and expiry,
 * but no guess ever matches it (it would otherwise open a verified account without a password).
 */

const { db, close } = createDatabase(testDatabaseUrl());

afterAll(async () => {
  await db
    .delete(customerVerifications)
    .where(like(customerVerifications.identifier, '%@test.vertex-digital.local'));
  await close();
});

describe('decoy codes', () => {
  it('match no 6-digit code at all', async () => {
    const email = uniqueEmail('decoy');
    await db.transaction((tx) => issueDecoyCode(tx, 'email-verification', email));
    const [row] = await db
      .select({ value: customerVerifications.value })
      .from(customerVerifications)
      .where(like(customerVerifications.identifier, `%${email}`));
    const storedHash = row?.value.split(':')[0] ?? '';
    // Every 6-digit code hashes to something else than the decoy's hash.
    const { createHash } = await import('node:crypto');
    for (let n = 0; n < 1_000_000; n += 1) {
      const code = n.toString().padStart(6, '0');
      const hash = createHash('sha256').update(`${code}:`).digest('hex');
      if (hash === storedHash) throw new Error(`Decoy matched ${code}`);
    }
  });

  it('count tries like a real code: the sixth try is refused as too many', async () => {
    const email = uniqueEmail('decoy-tries');
    await db.transaction((tx) => issueDecoyCode(tx, 'forget-password', email));
    const answers: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const check = await db.transaction((tx) => checkCode(tx, 'forget-password', email, '123456'));
      answers.push(check.ok ? 'ok' : check.code);
    }
    expect(answers).toEqual([...Array(5).fill('INVALID_OTP'), 'TOO_MANY_ATTEMPTS']);
  });

  it('are replaced by a real code, which then works', async () => {
    const email = uniqueEmail('decoy-then-real');
    await db.transaction((tx) => issueDecoyCode(tx, 'email-verification', email));
    const code = await db.transaction((tx) => issueCode(tx, 'email-verification', email));
    const check = await db.transaction((tx) => checkCode(tx, 'email-verification', email, code));
    expect(check).toEqual({ ok: true });
  });
});
