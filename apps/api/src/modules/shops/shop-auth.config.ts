import { createHmac } from 'node:crypto';
import {
  type Database,
  newId,
  shopCustomerAccounts,
  shopCustomerSessions,
  shopCustomers,
  shopCustomerVerifications,
} from '@vertex-digital/db';
import { BASE_ERROR_CODES, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Env } from '../../core/config/env.js';
import { betterAuthLogger } from '../../core/errors/better-auth-logger.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { SignInFailures } from '../../core/rate-limit/sign-in-failures.js';
import type { SessionProof, ShopAccountsService, ShopOfRequest } from './shop-accounts.service.js';
import { currentShopId } from './shop-scope.js';

/** The shop realm's Better Auth paths, as the instance sees them (`/api/shops/:slug/auth/*` outside). */
export const SHOP_AUTH_BASE_PATH = '/api/shops/auth';

/** Paths under a shop's `auth/` that the shops module's Nest routes serve instead of Better Auth. */
export const SHOP_AUTH_NEST_PATHS = [
  '/sign-up',
  '/send-verification-otp',
  '/request-password-reset',
  '/reset-password',
] as const;

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
  '/forget-password',
  '/reset-password',
  '/verify-password',
  '/verify-email',
  '/send-verification-email',
  '/update-session',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/list-sessions',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  '/refresh-token',
  '/get-access-token',
  '/account-info',
];
const DISABLED_ROUTES = ['/callback/:id', '/reset-password/:token'];

/** S01 rule C8 per shop: 10 sign-ins a minute per address; ALTCHA after 3 failures per email. */
const SIGN_IN_PER_MINUTE = 10;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;

type Where = { field: string; value: unknown; operator?: string; connector?: 'AND' | 'OR' }[];

/**
 * ADR 0040: every user and session lookup carries the request's shop, and every user and session
 * created takes it. Sessions are scoped too: Better Auth reads a session with its user in one
 * query, so the user's scope alone would not keep shop A's session out of shop B.
 */
function scoped<Adapter extends Record<string, unknown>>(adapter: Adapter): Adapter {
  const models = new Set(['user', 'session']);
  const scope = (model: string, where: Where | undefined): Where | undefined =>
    models.has(model)
      ? [...(where ?? []), { field: 'shopId', value: currentShopId(), connector: 'AND' }]
      : where;
  const wrap = (inner: Record<string, (...args: never[]) => unknown>): Adapter =>
    ({
      ...inner,
      findOne: (args: { model: string; where?: Where }) =>
        inner.findOne?.({ ...args, where: scope(args.model, args.where) } as never),
      findMany: (args: { model: string; where?: Where }) =>
        inner.findMany?.({ ...args, where: scope(args.model, args.where) } as never),
      count: (args: { model: string; where?: Where }) =>
        inner.count?.({ ...args, where: scope(args.model, args.where) } as never),
      update: (args: { model: string; where: Where }) =>
        inner.update?.({ ...args, where: scope(args.model, args.where) } as never),
      updateMany: (args: { model: string; where: Where }) =>
        inner.updateMany?.({ ...args, where: scope(args.model, args.where) } as never),
      delete: (args: { model: string; where: Where }) =>
        inner.delete?.({ ...args, where: scope(args.model, args.where) } as never),
      deleteMany: (args: { model: string; where: Where }) =>
        inner.deleteMany?.({ ...args, where: scope(args.model, args.where) } as never),
      create: (args: { model: string; data: Record<string, unknown> }) =>
        inner.create?.(
          (models.has(args.model)
            ? { ...args, data: { ...args.data, shopId: currentShopId() } }
            : args) as never,
        ),
      ...(inner.transaction && {
        transaction: (work: (trx: unknown) => unknown) =>
          inner.transaction?.(((trx: Record<string, (...args: never[]) => unknown>) =>
            work(wrap(trx))) as never),
      }),
    }) as unknown as Adapter;
  return wrap(adapter as unknown as Record<string, (...args: never[]) => unknown>);
}

const emailOf = (body: unknown): string => {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
};

export const metaOf = (headers: Headers | undefined): RequestMeta => ({
  ipAddress: headers?.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
  userAgent: headers?.get('user-agent')?.slice(0, 500) ?? null,
});

const toApiError = (error: unknown): unknown =>
  error instanceof CodedException
    ? new APIError(error.getStatus() === 429 ? 'TOO_MANY_REQUESTS' : 'BAD_REQUEST', {
        code: error.code,
        message: error.message,
      })
    : error;

/**
 * The two Better Auth endpoints that open a session on a proof: the sign-up code (CA2) and the
 * invitation (CA1). The proof is the accounts service's transaction; the session is checked
 * again after it is created, so a reset in between leaves none.
 */
const proofPlugin = (accounts: ShopAccountsService, shopOf: () => Promise<ShopOfRequest>) => {
  const open = async (
    // biome-ignore lint/suspicious/noExplicitAny: Better Auth's endpoint context
    ctx: any,
    proof: SessionProof,
  ) => {
    const user = await ctx.context.internalAdapter.findUserById(proof.shopCustomerId);
    if (!user) throw new APIError('BAD_REQUEST', BASE_ERROR_CODES.USER_NOT_FOUND);
    const session = await ctx.context.internalAdapter.createSession(proof.shopCustomerId);
    if (!(await accounts.proofStillHolds(proof))) {
      await ctx.context.internalAdapter.deleteSession(session.token);
      throw new APIError('BAD_REQUEST', {
        code: 'PASSWORD_MISMATCH',
        message: 'The password changed meanwhile',
      });
    }
    await setSessionCookie(ctx, { session, user });
    return ctx.json({ status: true, user: { id: user.id, name: user.name, email: user.email } });
  };
  return {
    id: 'vertex-shop-proofs',
    endpoints: {
      shopVerifyEmail: createAuthEndpoint(
        '/email-otp/verify-email',
        {
          method: 'POST',
          body: z.object({
            email: z.string().max(254),
            otp: z.string().max(10),
            password: z.string().min(1).max(128),
          }),
        },
        async (ctx) => {
          let proof: SessionProof;
          try {
            proof = await accounts.verifyEmail(
              await shopOf(),
              ctx.body,
              metaOf(ctx.request?.headers),
            );
          } catch (error) {
            throw toApiError(error);
          }
          return open(ctx, proof);
        },
      ),
      shopAcceptInvitation: createAuthEndpoint(
        '/invitation',
        {
          method: 'POST',
          body: z.object({
            token: z.string().min(20).max(200),
            password: z.string().min(8).max(128),
          }),
        },
        async (ctx) => {
          let proof: SessionProof;
          try {
            proof = await accounts.acceptInvitation(
              await shopOf(),
              ctx.body,
              metaOf(ctx.request?.headers),
            );
          } catch (error) {
            throw toApiError(error);
          }
          return open(ctx, proof);
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path === '/email-otp/verify-email' || path === '/invitation',
        window: 60,
        max: SIGN_IN_PER_MINUTE,
      },
    ],
  } satisfies BetterAuthPlugin;
};

/**
 * The shop customers' Better Auth instance (ADR 0040): its own tables, cookie (`vds`) and secret
 * (derived from the customer secret, so no new value to provision). Every lookup is scoped to the
 * request's shop (`scoped`); a session of shop A is no session on shop B.
 */
export function createShopAuth(
  db: Database,
  env: Env,
  accounts: ShopAccountsService,
  shopOf: () => Promise<ShopOfRequest>,
  verifyAltcha: (header: string | undefined) => Promise<void>,
) {
  const production = env.NODE_ENV === 'production';
  const failures = new SignInFailures(3, 15 * 60 * 1000);
  const secret = createHmac('sha256', env.CUSTOMER_AUTH_SECRET)
    .update('vertex-digital:shop-auth')
    .digest('hex');
  const adapter = drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: shopCustomers,
      session: shopCustomerSessions,
      account: shopCustomerAccounts,
      verification: shopCustomerVerifications,
    },
  });
  return betterAuth({
    appName: 'Vertex Digital',
    baseURL: env.STORE_URL,
    basePath: SHOP_AUTH_BASE_PATH,
    secret,
    logger: betterAuthLogger('ShopAuth'),
    trustedOrigins: [env.STORE_URL],
    database: ((options: Parameters<typeof adapter>[0]) =>
      scoped(adapter(options) as unknown as Record<string, unknown>)) as unknown as typeof adapter,
    user: {
      additionalFields: {
        shopId: { type: 'string', required: false, input: false },
        phone: { type: 'string', required: false, input: false },
        frozenAt: { type: 'date', required: false, input: false },
        archivedAt: { type: 'date', required: false, input: false },
      },
    },
    session: {
      expiresIn: SESSION_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
      additionalFields: { shopId: { type: 'string', required: false, input: false } },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    emailVerification: {
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user }, request) => {
        await accounts.sendVerificationCodeOnSignIn(
          await shopOf(),
          user.email,
          metaOf(request?.headers),
        );
      },
    },
    disabledPaths: DISABLED_PATHS,
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 60, max: SIGN_IN_PER_MINUTE } },
    },
    plugins: [proofPlugin(accounts, shopOf)],
    databaseHooks: {
      session: {
        create: {
          // CA9: an archived shop customer gets no session, whatever the path.
          before: async (session) => {
            const [customer] = await db
              .select({ archivedAt: shopCustomers.archivedAt })
              .from(shopCustomers)
              .where(
                and(
                  eq(shopCustomers.id, session.userId),
                  eq(shopCustomers.shopId, currentShopId()),
                ),
              );
            if (!customer || customer.archivedAt) {
              throw APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (DISABLED_ROUTES.includes(ctx.path) || DISABLED_PATHS.includes(ctx.path)) {
          throw new APIError('NOT_FOUND');
        }
        const key = `${currentShopId()}:${emailOf(ctx.body)}`;
        if (ctx.path === '/sign-in/email' && failures.blocked(key)) {
          try {
            await verifyAltcha(ctx.headers?.get('x-altcha') ?? undefined);
          } catch (error) {
            if (!(error instanceof CodedException)) throw error;
            throw new APIError('BAD_REQUEST', { code: error.code, message: error.message });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const key = `${currentShopId()}:${emailOf(ctx.body)}`;
        const returned = ctx.context.returned;
        if (returned instanceof APIError) {
          if (returned.statusCode === 401) failures.fail(key);
          return;
        }
        failures.clear(key);
      }),
    },
    advanced: {
      cookiePrefix: production ? '__Host-vds' : 'vds',
      useSecureCookies: false,
      defaultCookieAttributes: { secure: production, sameSite: 'lax', path: '/' },
      database: { generateId: () => newId() },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
  });
}

export type ShopAuth = ReturnType<typeof createShopAuth>;
