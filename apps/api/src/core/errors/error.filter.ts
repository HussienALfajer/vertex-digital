import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { ErrorCode, ErrorResponse } from '@vertex-digital/contracts';
import type { Response } from 'express';
import { CodedException } from './coded-exception.js';

/** The code of an uncoded HTTP error, by status. */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

/** The `ErrorResponse` for an error, and whether it is a server fault to report. */
export function errorResponseOf(exception: unknown): { body: ErrorResponse; fault: boolean } {
  if (exception instanceof CodedException) {
    return { body: exception.getResponse() as ErrorResponse, fault: false };
  }
  const status =
    exception instanceof HttpException
      ? exception.getStatus()
      : // Errors from Express middleware (the body parser) carry their status.
        typeof (exception as { status?: unknown })?.status === 'number'
        ? (exception as { status: number }).status
        : 500;
  if (status >= 500 || status < 400) {
    return {
      body: { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' },
      fault: true,
    };
  }
  const message = exception instanceof Error ? exception.message : 'Request failed';
  return {
    body: { statusCode: status, code: CODE_BY_STATUS[status] ?? 'BAD_REQUEST', message },
    fault: false,
  };
}

/**
 * Every error answers `{ statusCode, code, message }` (ADR 0011). A server fault keeps its details
 * in the logs and Sentry only: the response never shows internals.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { body, fault } = errorResponseOf(exception);
    if (fault) {
      this.logger.error(exception);
      Sentry.captureException(exception);
    }
    host.switchToHttp().getResponse<Response>().status(body.statusCode).json(body);
  }
}
