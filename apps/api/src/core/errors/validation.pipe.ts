import { StandardSchemaValidationPipe } from '@nestjs/common';
import { PASSWORD_TOO_COMMON } from '@vertex-digital/contracts';
import { CodedException } from './coded-exception.js';

/**
 * Validates every parameter declared with `{ schema }` (Zod contracts through Standard Schema)
 * and answers `400 VALIDATION_FAILED` with the issues, so a form can mark its fields. A password
 * from the common-password list answers `400 PASSWORD_TOO_COMMON` (S01 rules C3, D6).
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) => {
      const details = issues.map((issue) => ({
        path: (issue.path ?? []).map((segment) =>
          typeof segment === 'object' ? segment.key : segment,
        ),
        message: issue.message,
      }));
      return details.some((issue) => issue.message === PASSWORD_TOO_COMMON)
        ? new CodedException(400, 'PASSWORD_TOO_COMMON', 'The password is too common', details)
        : new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', details);
    },
  });
}
