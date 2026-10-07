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
  })
  .refine((env) => Boolean(env.TELEGRAM_BOT_TOKEN) === Boolean(env.TELEGRAM_ALERTS_CHAT_ID), {
    message: 'TELEGRAM_BOT_TOKEN and TELEGRAM_ALERTS_CHAT_ID are set together',
    path: ['TELEGRAM_ALERTS_CHAT_ID'],
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
