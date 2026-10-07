import {
  customerAccounts,
  customerSessions,
  customers,
  customerVerifications,
  type Database,
  newId,
} from '@vertex-digital/db';
import { BASE_ERROR_CODES, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
// Straight from the file: `core/altcha/index.ts` reaches back here through `core/access`.
import { ALTCHA_HEADER } from '../../core/altcha/altcha.guard.js';
import type { Env } from '../../core/config/env.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { SignInFailures } from '../../core/rate-limit/sign-in-failures.js';
import type { AuthAccountService } from './auth-account.service.js';

export const CUSTOMER_AUTH_BASE_PATH = '/api/auth';

/**
 * Paths under `/api/auth` that the auth module's Nest routes serve instead of Better Auth: every
 * change to an account, so the change, its audit entry and its emails share one transaction.
 */
export const CUSTOMER_AUTH_NEST_PATHS = [
  '/sign-up/email',
  '/email-otp/send-verification-otp',
  '/email-otp/request-password-reset',
  '/email-otp/reset-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
  '/change-password',
  '/revoke-session',
  '/revoke-sessions',
] as const;

/**
 * Better Auth endpoints the store does not use. Account changes are Nest routes (above), audited;
 * Better Auth keeps the sign-in, the sign-out, the session and the session list.
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
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  '/refresh-token',
  '/get-access-token',
  '/account-info',
];

/** Paths with a path parameter: `disabledPaths` matches literal paths only. */
const DISABLED_ROUTES = ['/callback/:id', '/reset-password/:token'];

/**
 * Customer sign-in limits (ADR 0007, S01 rule C8): per client IP; after 3 failures for one email
 * within 15 minutes the sign-in asks for a solved ALTCHA. Not a lockout.
 */
export const CUSTOMER_SIGN_IN_LIMITS = {
  perIpPerMinute: 10,
  failuresBeforeAltcha: 3,
  accountWindowMs: 15 * 60 * 1000,
} as const;

/** Sessions last 30 days and are extended by use, at most once a day (rule C9). */
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;

const emailOf = (body: unknown): string => {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
};

const metaOf = (headers: Headers | undefined): RequestMeta => ({
  // nginx overwrites X-Forwarded-For with the client address (ADR 0009).
  ipAddress: headers?.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
  userAgent: headers?.get('user-agent')?.slice(0, 500) ?? null,
});

/** A coded error of the auth module, answered by Better Auth with its code (the store translates it). */
const toApiError = (error: unknown): unknown =>
  error instanceof CodedException
    ? new APIError(error.getStatus() === 429 ? 'TOO_MANY_REQUESTS' : 'BAD_REQUEST', {
        code: error.code,
        message: error.message,
      })
    : error;

/**
 * `POST /api/auth/email-otp/verify-email` (rule C7): the code verifies the email, then the
 * customer is signed in with one session. A Better Auth endpoint, so the session cookie is set the
 * way every other session's is; the verification itself is the account service's transaction.
 */
const verifyEmailPlugin = (accounts: AuthAccountService) =>
  ({
    id: 'vertex-verify-email',
    endpoints: {
      verifyEmailWithCode: createAuthEndpoint(
        '/email-otp/verify-email',
        {
          method: 'POST',
          body: z.object({ email: z.string().max(254), otp: z.string().max(10) }),
        },
        async (ctx) => {
          let customerId: string;
          try {
            customerId = await accounts.verifyEmail(
              ctx.body.email,
              ctx.body.otp,
              metaOf(ctx.request?.headers),
            );
          } catch (error) {
            throw toApiError(error);
          }
          const user = await ctx.context.internalAdapter.findUserById(customerId);
          if (!user) throw new APIError('BAD_REQUEST', BASE_ERROR_CODES.USER_NOT_FOUND);
          const session = await ctx.context.internalAdapter.createSession(customerId);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({
            status: true,
            user: { id: user.id, name: user.name, email: user.email },
          });
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path === '/email-otp/verify-email',
        window: 60,
        max: CUSTOMER_SIGN_IN_LIMITS.perIpPerMinute,
      },
    ],
  }) satisfies BetterAuthPlugin;

/**
 * The customer Better Auth instance (ADR 0007), mounted at `/api/auth` on the store host. Its
 * cookie is `__Host-` and `Secure` in production; its name differs from the admin cookie so the
 * two never meet on one development host.
 */
export function createCustomerAuth(
  db: Database,
  env: Env,
  accounts: AuthAccountService,
  verifyAltcha: (header: string | undefined) => Promise<void>,
) {
  const production = env.NODE_ENV === 'production';
  const failures = new SignInFailures(
    CUSTOMER_SIGN_IN_LIMITS.failuresBeforeAltcha,
    CUSTOMER_SIGN_IN_LIMITS.accountWindowMs,
  );
  return betterAuth({
    appName: 'Vertex Digital',
    baseURL: env.STORE_URL,
    basePath: CUSTOMER_AUTH_BASE_PATH,
    secret: env.CUSTOMER_AUTH_SECRET,
    trustedOrigins: [env.STORE_URL],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: customers,
        session: customerSessions,
        account: customerAccounts,
        verification: customerVerifications,
      },
    }),
    user: {
      additionalFields: {
        phone: { type: 'string', required: false, input: false },
        isTest: { type: 'boolean', required: false, input: false },
        archivedAt: { type: 'date', required: false, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      // Sign-up is the auth module's route (rules C1, C2): Better Auth only signs in.
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    emailVerification: {
      // An unverified sign-in answers EMAIL_NOT_VERIFIED and sends a new code (account states).
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user }, request) => {
        await accounts.sendVerificationCodeOnSignIn(user.email, metaOf(request?.headers));
      },
    },
    session: { expiresIn: SESSION_SECONDS, updateAge: SESSION_REFRESH_SECONDS },
    disabledPaths: DISABLED_PATHS,
    // Memory storage is enough for these per-address limits: the API runs as one process (ADR
    // 0009). Code and sign-up limits are counted in PostgreSQL by the account service (rule C5).
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: CUSTOMER_SIGN_IN_LIMITS.perIpPerMinute },
      },
    },
    plugins: [verifyEmailPlugin(accounts)],
    databaseHooks: {
      session: {
        create: {
          // Covers every way to get a session: an archived customer gets none (rule C15).
          before: async (session) => {
            const [customer] = await db
              .select({ archivedAt: customers.archivedAt })
              .from(customers)
              .where(eq(customers.id, session.userId));
            if (!customer || customer.archivedAt) {
              throw APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (DISABLED_ROUTES.includes(ctx.path)) throw new APIError('NOT_FOUND');
        if (ctx.path === '/sign-in/email' && failures.blocked(emailOf(ctx.body))) {
          try {
            await verifyAltcha(ctx.headers?.get(ALTCHA_HEADER) ?? undefined);
          } catch (error) {
            if (!(error instanceof CodedException)) throw error;
            // Better Auth answers for itself: the code tells the store to show the challenge.
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
          return;
        }
        failures.clear(email);
        // Rule C10: every password sign-in sends the new sign-in email.
        const created = ctx.context.newSession;
        if (created) await accounts.sendSignInNotice(created.user, created.session);
      }),
    },
    advanced: {
      cookiePrefix: production ? '__Host-vd' : 'vd',
      // `__Host-` instead of Better Auth's `__Secure-`: host-only, path `/`, `Secure`.
      useSecureCookies: false,
      defaultCookieAttributes: { secure: production, sameSite: 'lax', path: '/' },
      database: { generateId: () => newId() },
      // nginx overwrites X-Forwarded-For with the client address (ADR 0009).
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
  });
}

export type CustomerAuth = ReturnType<typeof createCustomerAuth>;
