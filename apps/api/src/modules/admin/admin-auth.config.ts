import { randomInt } from 'node:crypto';
import { ADMIN_SESSION_RULES } from '@vertex-digital/contracts';
import {
  adminAccounts,
  adminSessions,
  adminTwoFactors,
  adminUsers,
  adminVerifications,
  type Database,
  newId,
  recordAudit,
} from '@vertex-digital/db';
import { BASE_ERROR_CODES, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { ALTCHA_HEADER } from '../../core/altcha/altcha.guard.js';
import type { Env } from '../../core/config/env.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { SignInFailures } from '../../core/rate-limit/sign-in-failures.js';

export const ADMIN_AUTH_BASE_PATH = '/api/admin/auth';

/**
 * Paths under `/api/admin/auth` that the admin module's Nest routes serve instead of Better
 * Auth: the password change, audited in its transaction and allowed before the setup is done.
 */
export const ADMIN_AUTH_NEST_PATHS = ['/change-password'] as const;

/**
 * Better Auth endpoints the panel does not use. The admin account is created and recovered on the
 * server (CLI, ADR 0016): no self sign-up, no emailed code, no reset by email, and TOTP cannot be
 * turned off. Own sessions are Nest routes (`/api/admin/me/sessions`), audited.
 */
const DISABLED_PATHS = [
  '/sign-up/email',
  '/sign-in/social',
  '/update-user',
  '/change-email',
  '/change-password',
  '/set-password',
  '/delete-user',
  '/delete-user/callback',
  '/request-password-reset',
  '/reset-password',
  '/verify-email',
  '/send-verification-email',
  '/update-session',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  '/refresh-token',
  '/get-access-token',
  '/account-info',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/send-otp',
  '/two-factor/verify-otp',
];

/** Paths with a path parameter: `disabledPaths` matches literal paths only. */
const DISABLED_ROUTES = ['/callback/:id', '/reset-password/:token'];

/**
 * Admin sign-in limits (ADR 0007): per client IP; per account whatever the address, after which
 * the sign-in asks for a solved ALTCHA. Not a lockout: anyone who knows the admin email could
 * otherwise keep the admin out of the panel.
 */
export const ADMIN_SIGN_IN_LIMITS = {
  perIpPerMinute: 10,
  failuresBeforeAltcha: 10,
  accountWindowMs: 15 * 60 * 1000,
} as const;

/** Paths that complete the TOTP step: the session they create is usable (`admin.signed_in`). */
const TOTP_STEP_PATHS = ['/two-factor/verify-totp', '/two-factor/verify-backup-code'];

/** Paths a session past its idle timeout may still reach: signing in and out. */
const IDLE_EXEMPT_PATHS = ['/sign-in/email', '/sign-out'];

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

const metaOf = (headers: Headers | undefined | null): RequestMeta => ({
  // nginx overwrites X-Forwarded-For with the client address (ADR 0009).
  ipAddress: headers?.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
  userAgent: headers?.get('user-agent')?.slice(0, 500) ?? null,
});

/** Whether a session saw no activity for the idle timeout (rule D4). */
export const isIdle = (lastActiveAt: Date, now = Date.now()) =>
  now - lastActiveAt.getTime() > ADMIN_SESSION_RULES.idleTimeoutMs;

/**
 * The admin Better Auth instance (ADR 0007, 0016): its own tables and secret, mounted at
 * `/api/admin/auth` on the admin host. TOTP is enrolled through the two-factor plugin; until it
 * is, every admin route answers `TWO_FACTOR_REQUIRED` (the access guard).
 */
export function createAdminAuth(
  db: Database,
  env: Env,
  verifyAltcha: (header: string | undefined) => Promise<void>,
) {
  const production = env.NODE_ENV === 'production';
  const failures = new SignInFailures(
    ADMIN_SIGN_IN_LIMITS.failuresBeforeAltcha,
    ADMIN_SIGN_IN_LIMITS.accountWindowMs,
  );
  const signInRule = { window: 60, max: ADMIN_SIGN_IN_LIMITS.perIpPerMinute };

  /** Audit entries of what the Better Auth plugin changes, written right after the change. */
  const audit = (
    action: 'admin.signed_in' | 'admin.two_factor_enabled' | 'admin.backup_codes_regenerated',
    adminId: string,
    meta: RequestMeta,
  ) =>
    db.transaction((tx) =>
      recordAudit(tx, {
        action,
        actorKind: 'admin',
        actorId: adminId,
        channel: 'admin',
        entityType: 'admin_user',
        entityId: adminId,
        details: {},
        ...meta,
      }),
    );

  return betterAuth({
    appName: 'Vertex Digital Admin',
    baseURL: env.ADMIN_URL,
    basePath: ADMIN_AUTH_BASE_PATH,
    secret: env.ADMIN_AUTH_SECRET,
    trustedOrigins: [env.ADMIN_URL],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: adminUsers,
        session: adminSessions,
        account: adminAccounts,
        verification: adminVerifications,
        twoFactor: adminTwoFactors,
      },
    }),
    user: {
      additionalFields: {
        mustChangePassword: { type: 'boolean', required: false, input: false },
        archivedAt: { type: 'date', required: false, input: false },
      },
    },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    // 12 hours from sign-in, never extended (rule D4); the idle timeout is checked on each use.
    session: {
      expiresIn: ADMIN_SESSION_RULES.absoluteLifetimeMs / 1000,
      disableSessionRefresh: true,
      additionalFields: {
        lastActiveAt: { type: 'date', required: false, input: false },
        reauthenticatedAt: { type: 'date', required: false, input: false },
      },
    },
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
        '/two-factor/generate-backup-codes': signInRule,
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
          // Covers every way to get a session, the TOTP step included: an archived admin gets none.
          before: async (session) => {
            const [admin] = await db
              .select({ archivedAt: adminUsers.archivedAt })
              .from(adminUsers)
              .where(eq(adminUsers.id, session.userId));
            if (!admin || admin.archivedAt) {
              throw APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
            }
          },
          // The TOTP step completed (sign-in or enrolment): the session is usable.
          after: async (session, ctx) => {
            if (ctx && TOTP_STEP_PATHS.includes(ctx.path)) {
              await audit('admin.signed_in', session.userId, metaOf(ctx.request?.headers));
            }
          },
        },
      },
      user: {
        update: {
          // The plugin turns TOTP on once, when the first code of the enrolment is right.
          after: async (user, ctx) => {
            if (ctx?.path === '/two-factor/verify-totp' && user.twoFactorEnabled) {
              await audit('admin.two_factor_enabled', user.id, metaOf(ctx.request?.headers));
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
        if (IDLE_EXEMPT_PATHS.includes(ctx.path)) return;
        // The access guard reads sessions from the server (no request) and answers idle expiry
        // with its own code; the panel's own reads come over HTTP.
        if (ctx.path === '/get-session' && !ctx.request) return;
        const current = await getSessionFromCtx(ctx);
        if (!current) return;
        const lastActiveAt = (current.session as { lastActiveAt?: Date | null }).lastActiveAt;
        if (lastActiveAt && isIdle(new Date(lastActiveAt))) {
          // Rule D4: the session is deleted; reading it answers "signed out".
          await ctx.context.internalAdapter.deleteSession(current.session.token);
          if (ctx.path === '/get-session') return;
          throw new APIError('UNAUTHORIZED', {
            code: 'SESSION_IDLE_EXPIRED',
            message: 'The session ended after 30 minutes without activity',
          });
        }
        // Rule D1: the CLI-issued password is changed before TOTP is enrolled.
        const mustChange = (current.user as { mustChangePassword?: boolean }).mustChangePassword;
        if (ctx.path === '/two-factor/enable' && mustChange) {
          throw new APIError('FORBIDDEN', {
            code: 'PASSWORD_CHANGE_REQUIRED',
            message: 'Change the password first',
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (ctx.path === '/sign-in/email') {
          const email = emailOf(ctx.body);
          if (returned instanceof APIError) {
            if (returned.statusCode === 401) failures.fail(email);
          } else {
            failures.clear(email);
          }
          return;
        }
        if (ctx.path === '/two-factor/generate-backup-codes' && !(returned instanceof APIError)) {
          const current = ctx.context.session;
          if (current) {
            await audit('admin.backup_codes_regenerated', current.user.id, metaOf(ctx.headers));
          }
        }
      }),
    },
    advanced: {
      cookiePrefix: production ? '__Host-vd-admin' : 'vd-admin',
      // `__Host-` instead of Better Auth's `__Secure-`: host-only, path `/`, `Secure`.
      useSecureCookies: false,
      defaultCookieAttributes: { secure: production, sameSite: 'lax', path: '/' },
      database: { generateId: () => newId() },
      // nginx overwrites X-Forwarded-For with the client address (ADR 0009).
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
  });
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;
