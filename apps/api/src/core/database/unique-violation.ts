/** A PostgreSQL unique violation (`23505`), raw or wrapped by Drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  const code = (value: unknown) => (value as { code?: unknown } | undefined)?.code;
  return code(error) === '23505' || code((error as { cause?: unknown })?.cause) === '23505';
}
