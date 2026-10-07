import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { withoutQueryParameters } from '@vertex-digital/db';

type Level = 'debug' | 'info' | 'success' | 'warn' | 'error';

/**
 * Better Auth's logger for one instance: its warnings and errors go through the Nest logger
 * (pino, never the console), errors to Sentry too, never with a query's parameters (codes,
 * emails, hashes) in them.
 */
export function betterAuthLogger(name: string) {
  const logger = new Logger(name);
  return {
    level: 'warn' as const,
    log: (level: Level, message: string, ...args: unknown[]) => {
      const safe = args.map(withoutQueryParameters);
      if (level !== 'error') {
        logger.warn(message);
        return;
      }
      logger.error(message, ...safe);
      const error = safe.find((arg) => arg instanceof Error);
      if (error) Sentry.captureException(error);
    },
  };
}
