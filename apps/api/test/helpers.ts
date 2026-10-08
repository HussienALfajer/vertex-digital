import { createHmac, randomUUID } from 'node:crypto';
import {
  STORE_SWITCH_DEFAULTS,
  STORE_SWITCHES,
  type StoreSwitchValues,
} from '@vertex-digital/contracts';
import {
  adminAccounts,
  adminUsers,
  auditEntries,
  customerAccounts,
  customerNotifications,
  customers,
  type Database,
  deposits,
  emailOutbox,
  ledgerAccounts,
  newId,
  notificationPreferences,
  storeSwitchChanges,
} from '@vertex-digital/db';
import { type Challenge, solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { hashPassword } from 'better-auth/crypto';
import { and, asc, desc, eq, inArray, like, notExists, or } from 'drizzle-orm';

/*
 * Shared helpers for API integration tests: seed accounts straight into the test database, sign
 * in over HTTP (with the TOTP step for the admin), and clean up. Test data is unique per run.
 */

export const STORE_ORIGIN = 'http://127.0.0.1:3001';
export const ADMIN_ORIGIN = 'http://127.0.0.1:5173';
export const PASSWORD = 'correct-horse-battery-staple';
/** A valid Syrian mobile number in E.164, as `phoneSchema` stores it. */
export const PHONE = '+963944123456';

/** The domain of every seeded email, so leftovers of an interrupted run can be found. */
const TEST_EMAIL_DOMAIN = '@test.vertex-digital.local';

export const uniqueEmail = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}${TEST_EMAIL_DOMAIN}`;

/** A Syrian mobile number of its own, for tests where a shared phone is a fraud flag (S03 FL5). */
export const uniquePhone = () =>
  `+9639${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;

/** A client address per call: sign-in and routes are rate limited per address. */
export const clientIp = () =>
  `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

export interface Seeded {
  id: string;
  email: string;
}

export async function seedCustomer(
  db: Database,
  input: { emailVerified?: boolean; archived?: boolean; isTest?: boolean; phone?: string } = {},
): Promise<Seeded> {
  const id = newId();
  const email = uniqueEmail('customer');
  await db.insert(customers).values({
    id,
    name: 'عميل اختبار',
    email,
    phone: input.phone ?? PHONE,
    emailVerified: input.emailVerified ?? true,
    isTest: input.isTest ?? false,
    archivedAt: input.archived ? new Date() : null,
  });
  await db.insert(customerAccounts).values({
    userId: id,
    accountId: id,
    providerId: 'credential',
    password: await hashPassword(PASSWORD),
  });
  return { id, email };
}

/**
 * Seeds the admin account. There is at most one (ADR 0016), so any admin a previous test seeded is
 * removed first, with its sessions: tests never keep two admins at once.
 */
export async function seedAdmin(db: Database, input: { archived?: boolean } = {}): Promise<Seeded> {
  const id = newId();
  const email = uniqueEmail('admin');
  await db.delete(adminUsers);
  await db.insert(adminUsers).values({
    id,
    name: 'مدير اختبار',
    email,
    archivedAt: input.archived ? new Date() : null,
  });
  await db.insert(adminAccounts).values({
    userId: id,
    accountId: id,
    providerId: 'credential',
    password: await hashPassword(PASSWORD),
  });
  return { id, email };
}

/**
 * Customers without a wallet or a deposit. A customer with either stays in the test database: the
 * ledger, the adjustments and the deposits reference it for good (S02, S03), as those rows stay.
 */
const withoutWallet = (db: Database) =>
  and(
    notExists(
      db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.customerId, customers.id)),
    ),
    notExists(
      db.select({ id: deposits.id }).from(deposits).where(eq(deposits.customerId, customers.id)),
    ),
    // Notifications are never deleted (S05 rule NT1).
    notExists(
      db
        .select({ id: customerNotifications.id })
        .from(customerNotifications)
        .where(eq(customerNotifications.customerId, customers.id)),
    ),
  );

/**
 * Removes seeded customers (but those with a wallet) and the admin with their sessions and
 * accounts (cascade) and their emails. Audit entries stay: the log is append-only by design.
 */
export async function removeAccounts(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(emailOutbox).where(inArray(emailOutbox.customerId, ids));
  await db.delete(notificationPreferences).where(inArray(notificationPreferences.customerId, ids));
  await db.delete(customers).where(and(inArray(customers.id, ids), withoutWallet(db)));
  await db.delete(adminUsers).where(inArray(adminUsers.id, ids));
}

/** Removes accounts an interrupted earlier run left behind. */
export async function removeLeftovers(db: Database): Promise<void> {
  const leftovers = db
    .select({ id: customers.id })
    .from(customers)
    .where(like(customers.email, `%${TEST_EMAIL_DOMAIN}`));
  await db
    .delete(emailOutbox)
    .where(
      or(
        inArray(emailOutbox.customerId, leftovers),
        like(emailOutbox.toAddress, `%${TEST_EMAIL_DOMAIN}`),
      ),
    );
  await db
    .delete(notificationPreferences)
    .where(inArray(notificationPreferences.customerId, leftovers));
  await db
    .delete(customers)
    .where(and(like(customers.email, `%${TEST_EMAIL_DOMAIN}`), withoutWallet(db)));
  await db.delete(adminUsers).where(like(adminUsers.email, `%${TEST_EMAIL_DOMAIN}`));
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

/** The current 6-digit TOTP code (RFC 6238, SHA-1, 30 s) for a base32 secret. */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/** Solves an ALTCHA challenge like the widget and encodes the `X-Altcha` payload it sends. */
export async function solveAltcha(challenge: Challenge, tamper = false): Promise<string> {
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error('Challenge not solved');
  const payload = {
    challenge: { parameters: challenge.parameters, signature: challenge.signature },
    // The derived key is the proof of work (its HMAC is in the challenge): a wrong one fails.
    solution: tamper ? { ...solution, derivedKey: 'ab'.repeat(32) } : solution,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/** A JSON response with its HTTP status as `status`, for one-line assertions. */
export const body = async (response: Response): Promise<Record<string, unknown>> => ({
  status: response.status,
  ...((await response.json()) as Record<string, unknown>),
});

export const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

export interface RequestOptions {
  cookie?: string;
  body?: unknown;
  ip?: string;
  /** Defaults to the origin of the route's host: admin for `/api/admin`, else the store. */
  origin?: string | null;
  headers?: Record<string, string>;
  /** A multipart body (uploads); the boundary header comes with it. */
  form?: FormData;
}

/** An HTTP client for the test app that looks like a browser on the right host. */
export function api(url: string) {
  const request = (method: string, path: string, options: RequestOptions = {}) => {
    const origin =
      options.origin === undefined
        ? path.startsWith('/api/admin')
          ? ADMIN_ORIGIN
          : STORE_ORIGIN
        : options.origin;
    return fetch(`${url}${path}`, {
      method,
      headers: {
        ...(origin && { origin }),
        'x-forwarded-for': options.ip ?? clientIp(),
        ...(options.cookie && { cookie: options.cookie }),
        ...(options.body !== undefined && { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  };

  async function expectOk(response: Response, step: string): Promise<Response> {
    if (response.status !== 200) {
      throw new Error(`${step} failed: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  /** Signs a customer in with email and password; returns the session cookie. */
  async function signInCustomer(email: string): Promise<string> {
    const response = await request('POST', '/api/auth/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    return cookieHeader(await expectOk(response, 'Customer sign-in'));
  }

  /** Signs the admin in, with the TOTP step once enrolled; returns the cookie. */
  async function signInAdmin(email: string, totpSecret?: string): Promise<string> {
    const ip = clientIp();
    const response = await expectOk(
      await request('POST', '/api/admin/auth/sign-in/email', {
        body: { email, password: PASSWORD },
        ip,
      }),
      'Admin sign-in',
    );
    const body = (await response.clone().json()) as { twoFactorRedirect?: boolean };
    if (!body.twoFactorRedirect) return cookieHeader(response);
    if (!totpSecret) throw new Error('Admin sign-in needs a TOTP secret');
    const verified = await request('POST', '/api/admin/auth/two-factor/verify-totp', {
      cookie: cookieHeader(response),
      body: { code: totp(totpSecret) },
      ip,
    });
    return cookieHeader(await expectOk(verified, 'TOTP step'));
  }

  /** Enrols TOTP for the signed-in admin, the way the panel's setup page does. */
  async function enrolTotp(cookie: string): Promise<{ secret: string; cookie: string }> {
    const enabled = await expectOk(
      await request('POST', '/api/admin/auth/two-factor/enable', {
        cookie,
        body: { password: PASSWORD },
      }),
      'TOTP enable',
    );
    const { totpURI } = (await enabled.json()) as { totpURI: string };
    const secret = new URL(totpURI).searchParams.get('secret') ?? '';
    const verified = await expectOk(
      await request('POST', '/api/admin/auth/two-factor/verify-totp', {
        cookie,
        body: { code: totp(secret) },
      }),
      'TOTP verification',
    );
    return { secret, cookie: cookieHeader(verified) || cookie };
  }

  /** Seeds the admin, enrols TOTP and returns the admin signed in with it. */
  async function adminWithTotp(db: Database) {
    const admin = await seedAdmin(db);
    const { secret } = await enrolTotp(await signInAdmin(admin.email));
    return { ...admin, secret, cookie: await signInAdmin(admin.email, secret) };
  }

  /** A solved ALTCHA challenge, as the `X-Altcha` header the widget sends. */
  async function altcha(): Promise<Record<string, string>> {
    const challenge = (await (await request('GET', '/api/altcha/challenge')).json()) as Challenge;
    return { 'x-altcha': await solveAltcha(challenge) };
  }

  return {
    request,
    get: (path: string, options?: RequestOptions) => request('GET', path, options),
    post: (path: string, options?: RequestOptions) => request('POST', path, options),
    patch: (path: string, options?: RequestOptions) => request('PATCH', path, options),
    delete: (path: string, options?: RequestOptions) => request('DELETE', path, options),
    altcha,
    signInCustomer,
    signInAdmin,
    enrolTotp,
    adminWithTotp,
  };
}

/** A customer's notifications (S05 rule NT1), oldest first. */
export function notificationsOf(db: Database, customerId: string) {
  return db
    .select({
      event: customerNotifications.event,
      params: customerNotifications.params,
      readAt: customerNotifications.readAt,
    })
    .from(customerNotifications)
    .where(eq(customerNotifications.customerId, customerId))
    .orderBy(asc(customerNotifications.createdAt), asc(customerNotifications.id));
}

/** The emails queued to an address, oldest first. */
export function emailsTo(db: Database, address: string) {
  return db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.toAddress, address))
    .orderBy(asc(emailOutbox.createdAt));
}

/** The code of the last code email to an address (the worker has not cleared it in tests). */
export async function lastCode(db: Database, address: string): Promise<string> {
  const emails = await emailsTo(db, address);
  const code = (emails.at(-1)?.params as { code?: string } | null)?.code;
  if (!code) throw new Error(`No code email to ${address}`);
  return code;
}

/** The audit entries about one entity, oldest first. */
export function auditOf(db: Database, entityId: string) {
  return db
    .select()
    .from(auditEntries)
    .where(eq(auditEntries.entityId, entityId))
    .orderBy(asc(auditEntries.occurredAt), asc(auditEntries.id));
}

/**
 * Sets every store switch to its default, or to `overrides` (S05 rule SW8: tests open
 * registration through their fixtures). Switch rows are append-only and outlive a run, so each
 * file that depends on a switch sets it first; only switches that differ get a row.
 */
export async function setSwitches(
  db: Database,
  overrides: Partial<StoreSwitchValues> = {},
): Promise<void> {
  const wanted = { ...STORE_SWITCH_DEFAULTS, ...overrides };
  const rows = await db
    .selectDistinctOn([storeSwitchChanges.switch])
    .from(storeSwitchChanges)
    .orderBy(
      storeSwitchChanges.switch,
      desc(storeSwitchChanges.createdAt),
      desc(storeSwitchChanges.id),
    );
  const current = { ...STORE_SWITCH_DEFAULTS };
  for (const row of rows) current[row.switch] = row.value;
  const changes = STORE_SWITCHES.filter((name) => current[name] !== wanted[name]).map((name) => ({
    id: newId(),
    switch: name,
    value: wanted[name],
    adminId: newId(),
    channel: 'admin' as const,
  }));
  if (changes.length > 0) await db.insert(storeSwitchChanges).values(changes);
}
