import { randomInt } from 'node:crypto';
import {
  type Database,
  newId,
  staffAccounts,
  staffSessions,
  staffTwoFactors,
  staffUsers,
  staffVerifications,
} from '@vertex-digital/db';
import { BASE_ERROR_CODES, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { ALTCHA_HEADER } from '../../core/altcha/altcha.guard.js';
import type { Env } from '../../core/config/env.js';
import { CodedException } from '../../core/errors/index.js';
import { SignInFailures } from './sign-in-failures.js';

export const STAFF_AUTH_BASE_PATH = '/api/admin/auth';

/**
 * Better Auth endpoints the panel does not use. Staff are created by the owner (CLI, then F02);
 * there is no self sign-up, no emailed code and no password reset by email: the owner resets.
 */
const DISABLED_PATHS = [
  '/sign-up/email',
  '/sign-in/social',
  '/update-user',
  '/change-email',
  '/delete-user',
  '/delete-user/callback',
  '/request-password-reset',
  '/reset-password',
  '/verify-email',
  '/send-verification-email',
  '/update-session',
  '/link-social',
  '/unlink-account',
  '/refresh-token',
  '/get-access-token',
  '/account-info',
  '/two-factor/send-otp',
  '/two-factor/verify-otp',
];

/** Paths with a path parameter: `disabledPaths` matches literal paths only. */
const DISABLED_ROUTES = ['/callback/:id', '/reset-password/:token'];

/**
 * Staff sign-in limits (ADR 0007): per client IP; per account whatever the address, after which
 * the sign-in asks for a solved ALTCHA. Not a lockout: anyone who knows a staff email could
 * otherwise keep that member out of the panel.
 */
export const STAFF_SIGN_IN_LIMITS = {
  perIpPerMinute: 10,
  failuresBeforeAltcha: 10,
  accountWindowMs: 15 * 60 * 1000,
} as const;

/**
 * Session lifetime: 12 hours from sign-in, never extended. Provisional until the F02 spec sets
 * the idle timeout and the absolute lifetime.
 */
const STAFF_SESSION_SECONDS = 12 * 60 * 60;

/**
 * Backup codes are written down by hand: lowercase letters and digits without the look-alikes
 * (i, l, o, 0, 1), `xxxxx-xxxxx`, about 49 bits each, behind the sign-in limits.
 */
const BACKUP_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generateBackupCodes(amount = 10): string[] {
  const part = () =>
    Array.from(
      { length: 5 },
      () => BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)],
    ).join('');
  return Array.from({ length: amount }, () => `${part()}-${part()}`);
}

const emailOf = (body: unknown): string => {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
};

/**
 * The staff Better Auth instance (ADR 0007): its own tables and secret, mounted at
 * `/api/admin/auth` on the admin host. TOTP is enrolled through the two-factor plugin; until it
 * is, every staff route answers `TWO_FACTOR_REQUIRED` (the access guard).
 */
export function createStaffAuth(
  db: Database,
  env: Env,
  verifyAltcha: (header: string | undefined) => Promise<void>,
) {
  const production = env.NODE_ENV === 'production';
  const failures = new SignInFailures(
    STAFF_SIGN_IN_LIMITS.failuresBeforeAltcha,
    STAFF_SIGN_IN_LIMITS.accountWindowMs,
  );
  const signInRule = { window: 60, max: STAFF_SIGN_IN_LIMITS.perIpPerMinute };

  return betterAuth({
    appName: 'Vertex Digital Admin',
    baseURL: env.ADMIN_URL,
    basePath: STAFF_AUTH_BASE_PATH,
    secret: env.STAFF_AUTH_SECRET,
    trustedOrigins: [env.ADMIN_URL],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: staffUsers,
        session: staffSessions,
        account: staffAccounts,
        verification: staffVerifications,
        twoFactor: staffTwoFactors,
      },
    }),
    user: {
      additionalFields: {
        role: { type: 'string', required: true, input: false },
        archivedAt: { type: 'date', required: false, input: false },
      },
    },
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { expiresIn: STAFF_SESSION_SECONDS, disableSessionRefresh: true },
    disabledPaths: DISABLED_PATHS,
    // Memory storage is enough: the API runs as one process (ADR 0009).
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': signInRule,
        '/two-factor/verify-totp': signInRule,
        '/two-factor/verify-backup-code': signInRule,
        // These check the password again, so they are guessable like the sign-in.
        '/two-factor/enable': signInRule,
        '/two-factor/disable': signInRule,
        '/two-factor/generate-backup-codes': signInRule,
        '/change-password': signInRule,
      },
    },
    plugins: [
      twoFactor({
        issuer: 'Vertex Digital',
        skipVerificationOnEnable: false,
        backupCodeOptions: { customBackupCodesGenerate: () => generateBackupCodes() },
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          // Covers every way to get a session, the TOTP step included: archived staff get none.
          before: async (session) => {
            const [member] = await db
              .select({ archivedAt: staffUsers.archivedAt })
              .from(staffUsers)
              .where(eq(staffUsers.id, session.userId));
            if (!member || member.archivedAt) {
              throw APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (DISABLED_ROUTES.includes(ctx.path)) throw new APIError('NOT_FOUND');
        // No "trust this device": the TOTP code is asked at every sign-in (ADR 0007).
        if (ctx.body?.trustDevice) {
          throw new APIError('BAD_REQUEST', { message: 'Trusted devices are not supported' });
        }
        if (ctx.path === '/sign-in/email' && failures.blocked(emailOf(ctx.body))) {
          try {
            await verifyAltcha(ctx.headers?.get(ALTCHA_HEADER) ?? undefined);
          } catch (error) {
            if (!(error instanceof CodedException)) throw error;
            // Better Auth answers for itself: the code tells the panel to show the challenge.
            throw new APIError('BAD_REQUEST', { code: error.code, message: error.message });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const email = emailOf(ctx.body);
        const returned = ctx.context.returned;
        if (returned instanceof APIError) {
          if (returned.statusCode === 401) failures.fail(email);
        } else {
          failures.clear(email);
        }
      }),
    },
    advanced: {
      cookiePrefix: production ? '__Host-vd-staff' : 'vd-staff',
      // `__Host-` instead of Better Auth's `__Secure-`: host-only, path `/`, `Secure`.
      useSecureCookies: false,
      defaultCookieAttributes: { secure: production, sameSite: 'lax', path: '/' },
      database: { generateId: () => newId() },
      // nginx overwrites X-Forwarded-For with the client address (ADR 0009).
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
  });
}

export type StaffAuth = ReturnType<typeof createStaffAuth>;
