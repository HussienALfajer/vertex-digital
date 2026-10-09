import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { type UsdtMethod, usdtAddressSchemas } from '@vertex-digital/contracts';
import { z } from 'zod';

/** A value `.env.example` ships, never a real secret. */
const isPlaceholder = (value: string) =>
  value.startsWith('replace-') || value.includes('replace-me');

/** Empty, or a value `.env.example` ships (never a real secret), counts as unset. */
const optional = () =>
  z
    .string()
    .optional()
    .transform((value) => (value && !isPlaceholder(value) ? value : undefined));

/** The all-zero addresses an older `.env.example` shipped count as unset. */
const isPlaceholderAddress = (value: string) => /^(T|0x)0+$/.test(value);

/**
 * A USDT receiving address (S04 rule U1, edge case 17), checked as the API checks it: unset or a
 * placeholder leaves the network unscanned; a value that fails its checksum stops the start.
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

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Identifies this worker process in the heartbeat table. */
    WORKER_NAME: z.string().min(1).default(hostname()),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Empty disables Sentry. */
    SENTRY_DSN: optional().pipe(z.url().optional()),
    /**
     * The Telegram admin bot (S05 F07, ADR 0019): its token lives here only; the API never holds
     * it. Unset, nothing is sent to Telegram (messages are `skipped`, alerts logged).
     */
    TELEGRAM_BOT_TOKEN: optional().pipe(
      z
        .string()
        .regex(/^\d+:[\w-]+$/)
        .optional(),
    ),
    /** The `secret_token` the worker registers with `setWebhook`; the API's value. */
    TELEGRAM_WEBHOOK_SECRET: optional().pipe(
      z
        .string()
        .regex(/^[\w-]{32,256}$/)
        .optional(),
    ),
    /** The webhook Telegram posts updates to: `https://<store host>/api/webhooks/telegram`. */
    TELEGRAM_WEBHOOK_URL: optional().pipe(z.url({ protocol: /^https$/ }).optional()),
    /**
     * How bot messages and alerts leave: `log` writes each one, with its buttons, as a JSON file
     * under TELEGRAM_LOG_DIR and calls nothing (development and tests); `api` calls Telegram, the
     * default and the only choice in production.
     */
    TELEGRAM_TRANSPORT: z.enum(['log', 'api']).optional(),
    TELEGRAM_LOG_DIR: z.string().min(1).default('./.data/telegram'),
    /** The Bot API origin; tests point it at a local fake server. */
    TELEGRAM_API_URL: z.url().default('https://api.telegram.org'),
    /**
     * How emails leave (S01 rule E5): `log` writes each one to a file under EMAIL_LOG_DIR and sends
     * nothing (development and tests); `smtp` sends, and is the only choice in production.
     */
    /** The store's origin, for links in emails (S02: the wallet page). */
    STORE_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:3001'),
    /** The panel's origin, for links in Telegram messages (S05: deposit cards, reminders). */
    ADMIN_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:5173'),
    /**
     * The API's stored files (S03), read for the receipt of a deposit card (S05 rule TC2). A
     * relative path is the API's: resolved from `apps/api`, as the API runs there.
     */
    FILES_ROOT: z.string().min(1).default('./.data/files'),
    EMAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
    EMAIL_LOG_DIR: z.string().min(1).default('./.data/emails'),
    EMAIL_FROM: z.email().default('info@vertexmedia.pro'),
    SMTP_HOST: optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    SMTP_USER: optional(),
    SMTP_PASSWORD: optional(),
    USDT_TRC20_ADDRESS: usdtAddress('usdt_trc20'),
    USDT_BEP20_ADDRESS: usdtAddress('usdt_bep20'),
    /**
     * Where USDT transfers are read (S04): `live` reads TRON and BSC; `fake` reads the transfers
     * `usdt:fake-transfer` writes to FAKE_CHAIN_FILE (development; refused in production).
     */
    CHAIN_READER: z
      .preprocess(
        // `stub` is the name an older `.env.example` used for `fake`.
        (value) => (value === 'stub' ? 'fake' : value),
        z.enum(['live', 'fake']),
      )
      .default('fake'),
    FAKE_CHAIN_FILE: z.string().min(1).default('./.data/fake-chain.json'),
    TRONGRID_API_URL: z.url({ protocol: /^https$/ }).default('https://api.trongrid.io'),
    TRONGRID_API_KEY: optional(),
    /** A BSC JSON-RPC endpoint; a provider's key goes in the URL, so it is a secret. */
    BSC_RPC_URL: optional().pipe(z.url({ protocol: /^https$/ }).optional()),
    /**
     * The AES-256-GCM key of supplier credentials (S07 rule SP2): 32 bytes in base64, the API's
     * value. Required in production; derived locally exactly as the API derives it.
     */
    SUPPLIER_KEYS_SECRET: optional().pipe(
      z
        .string()
        .refine((value) => Buffer.from(value, 'base64').length === 32, 'Expected 32 bytes')
        .optional(),
    ),
    /**
     * The AES-256-GCM key of order codes and supplier webhook bodies (S08 rule C1): 32 bytes in
     * base64, the API's value. Required in production; derived locally exactly as the API does.
     */
    ORDER_CODES_SECRET: optional().pipe(
      z
        .string()
        .refine((value) => Buffer.from(value, 'base64').length === 32, 'Expected 32 bytes')
        .optional(),
    ),
    /** The fake supplier (S07 rule SP1): development and E2E only, refused in production. */
    SUPPLIER_FAKE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /** The fake supplier's scripted state, written by `supplier:fake` (development). */
    FAKE_SUPPLIER_STATE_FILE: z.string().min(1).default('./.data/fake-supplier.json'),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.TELEGRAM_TRANSPORT !== 'log', {
    message: 'Production sends Telegram messages through the Bot API',
    path: ['TELEGRAM_TRANSPORT'],
  })
  .refine(
    (env) =>
      (env.TELEGRAM_TRANSPORT ?? (env.NODE_ENV === 'production' ? 'api' : 'log')) !== 'api' ||
      !env.TELEGRAM_BOT_TOKEN ||
      Boolean(env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_WEBHOOK_URL),
    {
      message: 'TELEGRAM_WEBHOOK_SECRET and TELEGRAM_WEBHOOK_URL are required with the bot token',
      path: ['TELEGRAM_WEBHOOK_URL'],
    },
  )
  .refine((env) => env.NODE_ENV !== 'production' || env.EMAIL_TRANSPORT === 'smtp', {
    message: 'Production sends email over SMTP',
    path: ['EMAIL_TRANSPORT'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.SUPPLIER_KEYS_SECRET, {
    message: 'SUPPLIER_KEYS_SECRET is required',
    path: ['SUPPLIER_KEYS_SECRET'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.ORDER_CODES_SECRET, {
    message: 'ORDER_CODES_SECRET is required',
    path: ['ORDER_CODES_SECRET'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || !env.SUPPLIER_FAKE_ENABLED, {
    message: 'The fake supplier is never enabled in production',
    path: ['SUPPLIER_FAKE_ENABLED'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.CHAIN_READER === 'live', {
    message: 'Production reads the chains (CHAIN_READER=live)',
    path: ['CHAIN_READER'],
  })
  .refine((env) => env.CHAIN_READER !== 'live' || !env.USDT_TRC20_ADDRESS || env.TRONGRID_API_KEY, {
    message: 'TRONGRID_API_KEY is required to read TRON',
    path: ['TRONGRID_API_KEY'],
  })
  .refine((env) => env.CHAIN_READER !== 'live' || !env.USDT_BEP20_ADDRESS || env.BSC_RPC_URL, {
    message: 'BSC_RPC_URL is required to read BSC',
    path: ['BSC_RPC_URL'],
  })
  .refine(
    (env) =>
      env.EMAIL_TRANSPORT !== 'smtp' ||
      Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD),
    {
      message: 'SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required for SMTP',
      path: ['SMTP_HOST'],
    },
  )
  .transform((env) => ({
    ...env,
    // Outside production, the API's stable per-machine key: the same DATABASE_URL, the same label.
    SUPPLIER_KEYS_SECRET:
      env.SUPPLIER_KEYS_SECRET ??
      createHash('sha256')
        .update(`vertex-digital-dev-supplier-keys:${env.DATABASE_URL}`)
        .digest('base64'),
    ORDER_CODES_SECRET:
      env.ORDER_CODES_SECRET ??
      createHash('sha256')
        .update(`vertex-digital-dev-order-codes:${env.DATABASE_URL}`)
        .digest('base64'),
    TELEGRAM_TRANSPORT:
      env.TELEGRAM_TRANSPORT ??
      (env.NODE_ENV === 'production' ? ('api' as const) : ('log' as const)),
  }));

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
