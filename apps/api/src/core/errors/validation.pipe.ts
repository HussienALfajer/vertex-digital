import { StandardSchemaValidationPipe } from '@nestjs/common';
import { CodedException } from './coded-exception.js';

/**
 * Validates every parameter declared with `{ schema }` (Zod contracts through Standard Schema)
 * and answers `400 VALIDATION_FAILED` with the issues, so a form can mark its fields.
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      new CodedException(
        400,
        'VALIDATION_FAILED',
        'Invalid input',
        issues.map((issue) => ({
          path: (issue.path ?? []).map((segment) =>
            typeof segment === 'object' ? segment.key : segment,
          ),
          message: issue.message,
        })),
      ),
  });
}
