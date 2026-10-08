/** A PostgreSQL unique violation (`23505`), raw or wrapped by Drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  const code = (value: unknown) => (value as { code?: unknown } | undefined)?.code;
  return code(error) === '23505' || code((error as { cause?: unknown })?.cause) === '23505';
}

/** A PostgreSQL unique violation's constraint, raw or wrapped by Drizzle; null otherwise. */
export function violatedConstraint(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const { code, constraint } = (candidate ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505') return typeof constraint === 'string' ? constraint : '';
  }
  return null;
}
