import { hostname } from 'node:os';
import { z } from 'zod';

/** Empty, or a value `.env.example` ships (never a real secret), counts as unset. */
const optional = () =>
  z
    .string()
    .optional()
    .transform((value) => (value && !value.includes('replace-me') ? value : undefined));

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
    /** The admin alert channel (ADR 0002): off unless both are set (Q11). */
    TELEGRAM_BOT_TOKEN: optional().pipe(
      z
        .string()
        .regex(/^\d+:[\w-]+$/)
        .optional(),
    ),
    TELEGRAM_ALERTS_CHAT_ID: optional().pipe(
      z
        .string()
        .regex(/^-?\d+$/)
        .optional(),
    ),
    /** The Bot API origin; tests point it at a local fake server. */
    TELEGRAM_API_URL: z.url().default('https://api.telegram.org'),
    /**
     * How emails leave (S01 rule E5): `log` writes each one to a file under EMAIL_LOG_DIR and sends
     * nothing (development and tests); `smtp` sends, and is the only choice in production.
     */
    /** The store's origin, for links in emails (S02: the wallet page). */
    STORE_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:3001'),
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
  })
  .refine((env) => Boolean(env.TELEGRAM_BOT_TOKEN) === Boolean(env.TELEGRAM_ALERTS_CHAT_ID), {
    message: 'TELEGRAM_BOT_TOKEN and TELEGRAM_ALERTS_CHAT_ID are set together',
    path: ['TELEGRAM_ALERTS_CHAT_ID'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.EMAIL_TRANSPORT === 'smtp', {
    message: 'Production sends email over SMTP',
    path: ['EMAIL_TRANSPORT'],
  })
  .refine(
    (env) =>
      env.EMAIL_TRANSPORT !== 'smtp' ||
      Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD),
    {
      message: 'SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required for SMTP',
      path: ['SMTP_HOST'],
    },
  );

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
