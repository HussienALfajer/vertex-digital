import { createHmac, randomUUID } from 'node:crypto';
import type { StaffRole } from '@vertex-digital/contracts';
import {
  customerAccounts,
  customers,
  type Database,
  newId,
  staffAccounts,
  staffUsers,
} from '@vertex-digital/db';
import { type Challenge, solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { hashPassword } from 'better-auth/crypto';
import { inArray, like } from 'drizzle-orm';

/*
 * Shared helpers for API integration tests: seed accounts straight into the test database, sign
 * in over HTTP (with the TOTP step for staff), and clean up. Test data is unique per run.
 */

export const STORE_ORIGIN = 'http://127.0.0.1:3001';
export const ADMIN_ORIGIN = 'http://127.0.0.1:5173';
export const PASSWORD = 'correct-horse-battery-staple';

/** The domain of every seeded email, so leftovers of an interrupted run can be found. */
const TEST_EMAIL_DOMAIN = '@test.vertex-digital.local';

export const uniqueEmail = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}${TEST_EMAIL_DOMAIN}`;

/** A client address per call: sign-in and routes are rate limited per address. */
export const clientIp = () =>
  `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`;

export interface Seeded {
  id: string;
  email: string;
}

export async function seedCustomer(
  db: Database,
  input: { emailVerified?: boolean; archived?: boolean } = {},
): Promise<Seeded> {
  const id = newId();
  const email = uniqueEmail('customer');
  await db.insert(customers).values({
    id,
    name: 'عميل اختبار',
    email,
    emailVerified: input.emailVerified ?? true,
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

export async function seedStaff(
  db: Database,
  input: { role?: StaffRole; archived?: boolean } = {},
): Promise<Seeded> {
  const id = newId();
  const email = uniqueEmail('staff');
  await db.insert(staffUsers).values({
    id,
    name: 'موظف اختبار',
    email,
    role: input.role ?? 'support',
    archivedAt: input.archived ? new Date() : null,
  });
  await db.insert(staffAccounts).values({
    userId: id,
    accountId: id,
    providerId: 'credential',
    password: await hashPassword(PASSWORD),
  });
  return { id, email };
}

/** Removes seeded customers and staff with their sessions and accounts (cascade). */
export async function removeAccounts(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(customers).where(inArray(customers.id, ids));
  await db.delete(staffUsers).where(inArray(staffUsers.id, ids));
}

/** Removes accounts an interrupted earlier run left behind. */
export async function removeLeftovers(db: Database): Promise<void> {
  await db.delete(customers).where(like(customers.email, `%${TEST_EMAIL_DOMAIN}`));
  await db.delete(staffUsers).where(like(staffUsers.email, `%${TEST_EMAIL_DOMAIN}`));
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
export const body = async (response: Response) => ({
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
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

  /** Signs a staff member in, with the TOTP step when they enrolled; returns the cookie. */
  async function signInStaff(email: string, totpSecret?: string): Promise<string> {
    const ip = clientIp();
    const response = await expectOk(
      await request('POST', '/api/admin/auth/sign-in/email', {
        body: { email, password: PASSWORD },
        ip,
      }),
      'Staff sign-in',
    );
    const body = (await response.clone().json()) as { twoFactorRedirect?: boolean };
    if (!body.twoFactorRedirect) return cookieHeader(response);
    if (!totpSecret) throw new Error('Staff sign-in needs a TOTP secret');
    const verified = await request('POST', '/api/admin/auth/two-factor/verify-totp', {
      cookie: cookieHeader(response),
      body: { code: totp(totpSecret) },
      ip,
    });
    return cookieHeader(await expectOk(verified, 'TOTP step'));
  }

  /** Enrols TOTP for a signed-in staff member, the way the panel's setup page does. */
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

  /** Seeds a staff member, enrols TOTP and returns them signed in with it. */
  async function staffWithTotp(db: Database, role: StaffRole) {
    const member = await seedStaff(db, { role });
    const { secret } = await enrolTotp(await signInStaff(member.email));
    return { ...member, secret, cookie: await signInStaff(member.email, secret) };
  }

  return {
    request,
    get: (path: string, options?: RequestOptions) => request('GET', path, options),
    post: (path: string, options?: RequestOptions) => request('POST', path, options),
    signInCustomer,
    signInStaff,
    enrolTotp,
    staffWithTotp,
  };
}
