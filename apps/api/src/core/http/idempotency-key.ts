import { applyDecorators, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { CodedException } from '../errors/index.js';

const HEADER = 'Idempotency-Key';

/**
 * The request's `Idempotency-Key` header (ADR 0004, 0011): a UUID the client generates per
 * attempt, lowercased. Missing or not a UUID answers `400 VALIDATION_FAILED`. Pair it with
 * `@ApiIdempotencyKey()` on the route so OpenAPI lists the header.
 */
export const IdempotencyKey = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<Request>().headers[HEADER.toLowerCase()];
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new CodedException(400, 'VALIDATION_FAILED', `${HEADER} must be a UUID`, [
      { path: [HEADER], message: 'Expected a UUID' },
    ]);
  }
  return parsed.data.toLowerCase();
});

export const ApiIdempotencyKey = () =>
  applyDecorators(
    ApiHeader({
      name: HEADER,
      required: true,
      description: 'A UUID per attempt; a retry with the same key returns the first result',
      schema: { type: 'string', format: 'uuid' },
    }),
  );
