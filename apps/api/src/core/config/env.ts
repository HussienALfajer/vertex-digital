import { createHash } from 'node:crypto';
import { type UsdtMethod, usdtAddressSchemas } from '@vertex-digital/contracts';
import { z } from 'zod';

/** Values `.env.example` ships: never secrets, so they count as unset. */
const isPlaceholder = (value: string) =>
  value.startsWith('replace-') || value.includes('replace-me');

/** A secret from the environment: empty or a placeholder counts as unset. */
const secret = () =>
  z
    .string()
    .optional()
    .transform((value) => (value && !isPlaceholder(value) ? value : undefined))
    .pipe(z.string().min(32).optional());

/** The all-zero placeholders an older `.env.example` shipped: a burn address, never a wallet. */
const isPlaceholderAddress = (value: string) => /^(T|0x)0+$/.test(value);

/**
 * A USDT receiving address (S04 rule U1): unset, empty or a placeholder makes its network
 * unavailable; a value that fails its checksum stops the start, so no deposit ever shows a
 * mistyped address.
 */
const usdtAddress = (method: UsdtMethod) =>
  z
    .string()
    .optional()
    .transform((value) => {
      const address = value?.trim();
      return address && !isPlaceholderAddress(address) ? address : undefined;
    })
    .pipe(usdtAddressSchemas[method].optional());

const origin = () => z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Public origin of the store; customer routes and `/api/auth` are served under it. */
    STORE_URL: origin().default('http://127.0.0.1:3001'),
    /** Public origin of the admin panel; `/api/admin` is served under it (ADR 0007). */
    ADMIN_URL: origin().default('http://127.0.0.1:5173'),
    /** Signs the customer sessions. Required in production; derived locally when unset. */
    CUSTOMER_AUTH_SECRET: secret(),
    /** Signs the admin sessions and encrypts TOTP secrets. Different from the customer one. */
    ADMIN_AUTH_SECRET: secret(),
    /** Signs ALTCHA challenges (ADR 0008). Required in production; derived locally when unset. */
    ALTCHA_HMAC_KEY: secret(),
    /**
     * Upper bound of the ALTCHA work counter: the average solve does half of it. Tests lower it
     * so a challenge solves in milliseconds.
     */
    ALTCHA_MAX_COUNTER: z.coerce.number().int().min(10).default(10_000),
    /**
     * Where uploaded files live (S03 receipts and QR images): outside the web root. Relative paths
     * resolve against the API's working directory.
     */
    FILES_ROOT: z.string().min(1).default('./.data/files'),
    /**
     * The nginx `internal` location that maps to `FILES_ROOT` (ADR 0009). When set, file routes
     * answer with `X-Accel-Redirect` and nginx sends the bytes; unset, the API sends them.
     */
    FILES_ACCEL_PREFIX: z
      .string()
      .optional()
      .transform((value) => value || undefined)
      .pipe(
        z
          .string()
          .regex(/^\/[\w/-]*[^/]$/)
          .optional(),
      ),
    /**
     * The owner's USDT receiving addresses (S04, ADR 0018): set on the server only, never in the
     * panel. Changing one needs a quiet moment with no open USDT deposits (`docs/deployment.md`).
     */
    USDT_TRC20_ADDRESS: usdtAddress('usdt_trc20'),
    USDT_BEP20_ADDRESS: usdtAddress('usdt_bep20'),
    /**
     * The Telegram admin bot (S05 rule TG1, ADR 0019): its username, for the link the panel shows.
     * Unset, the bot is not configured. The API never holds the bot token.
     */
    TELEGRAM_BOT_USERNAME: z
      .string()
      .optional()
      .transform((value) => value || undefined)
      .pipe(
        z
          .string()
          .regex(/^[A-Za-z]\w{3,31}$/)
          .optional(),
      ),
    /**
     * The `X-Telegram-Bot-Api-Secret-Token` every webhook call carries, shared with the worker,
     * which registers it with Telegram. Required in production with the bot; derived locally.
     */
    TELEGRAM_WEBHOOK_SECRET: secret().pipe(
      z
        .string()
        .regex(/^[\w-]{32,256}$/)
        .optional(),
    ),
    /** Empty disables Sentry. */
    SENTRY_DSN: z
      .string()
      .optional()
      .transform((value) => value || undefined)
      .pipe(z.url().optional()),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['CUSTOMER_AUTH_SECRET', 'ADMIN_AUTH_SECRET', 'ALTCHA_HMAC_KEY'] as const) {
      if (!env[key]) {
        context.addIssue({ code: 'custom', path: [key], message: `${key} is required` });
      }
    }
    if (env.TELEGRAM_BOT_USERNAME && !env.TELEGRAM_WEBHOOK_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message: 'TELEGRAM_WEBHOOK_SECRET is required with TELEGRAM_BOT_USERNAME',
      });
    }
    // Production is served over TLS: an http origin would issue cookies without `Secure` and
    // trust the wrong origin, so a lost or wrong value stops the start instead of weakening it.
    for (const key of ['STORE_URL', 'ADMIN_URL'] as const) {
      if (!env[key].startsWith('https://')) {
        context.addIssue({ code: 'custom', path: [key], message: `${key} must be https` });
      }
    }
    if (env.CUSTOMER_AUTH_SECRET && env.CUSTOMER_AUTH_SECRET === env.ADMIN_AUTH_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['ADMIN_AUTH_SECRET'],
        message: 'The admin and customer secrets must differ',
      });
    }
  })
  .transform((env) => {
    // Outside production, fall back to a stable per-machine value: DATABASE_URL carries the
    // random password `pnpm db:setup-local` generated, and it never leaves the machine.
    const derive = (label: string) =>
      createHash('sha256').update(`vertex-digital-dev-${label}:${env.DATABASE_URL}`).digest('hex');
    return {
      ...env,
      CUSTOMER_AUTH_SECRET: env.CUSTOMER_AUTH_SECRET ?? derive('customer-auth'),
      ADMIN_AUTH_SECRET: env.ADMIN_AUTH_SECRET ?? derive('admin-auth'),
      ALTCHA_HMAC_KEY: env.ALTCHA_HMAC_KEY ?? derive('altcha'),
      TELEGRAM_WEBHOOK_SECRET:
        env.TELEGRAM_WEBHOOK_SECRET ??
        (env.NODE_ENV === 'production' ? undefined : derive('telegram-webhook')),
    };
  });

export type Env = z.infer<typeof envSchema>;

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
