import {
  customerAccounts,
  customerSessions,
  customers,
  customerVerifications,
  type Database,
  newId,
} from '@vertex-digital/db';
import { BASE_ERROR_CODES, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import type { Env } from '../../core/config/env.js';

export const CUSTOMER_AUTH_BASE_PATH = '/api/auth';

/**
 * Better Auth endpoints the store does not use. Sign-up opens with F01 (email OTP, phone,
 * ALTCHA, per-email limits); password reset and email verification arrive with it as email OTP.
 */
const DISABLED_PATHS = [
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
];

/** Sign-in attempts per client IP and minute (ADR 0007, 0008); nginx limits in front. */
export const CUSTOMER_SIGN_IN_PER_MINUTE = 10;

/**
 * The customer Better Auth instance (ADR 0007), mounted at `/api/auth` on the store host. Its
 * cookie is `__Host-` and `Secure` in production; its name differs from the staff cookie so the
 * two never meet on one development host.
 */
export function createCustomerAuth(db: Database, env: Env) {
  const production = env.NODE_ENV === 'production';
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
        archivedAt: { type: 'date', required: false, input: false },
      },
    },
    emailAndPassword: { enabled: true, disableSignUp: true },
    disabledPaths: DISABLED_PATHS,
    // Memory storage is enough: the API runs as one process (ADR 0009).
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: CUSTOMER_SIGN_IN_PER_MINUTE },
        '/change-password': { window: 60, max: CUSTOMER_SIGN_IN_PER_MINUTE },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Covers every way to get a session: an archived customer gets none.
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
