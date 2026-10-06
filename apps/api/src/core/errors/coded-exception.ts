import { HttpException } from '@nestjs/common';
import type { ErrorCode, ErrorResponse } from '@vertex-digital/contracts';

/**
 * An error the UI tells apart by its code (ADR 0011). The body is `ErrorResponse`; the front ends
 * show the translation of `code`, never `message`.
 */
export class CodedException extends HttpException {
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 413 | 429,
    readonly code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    const body: ErrorResponse = {
      statusCode: status,
      code,
      message,
      ...(details !== undefined && { details }),
    };
    super(body, status);
  }
}
