/**
 * The error to log or report for a failed query. Drizzle's query errors carry the query and its
 * parameters in their message (codes, emails, phones, password hashes), and PostgreSQL's carry
 * values in `detail`: only the cause's class, code and message leave the process.
 */
export function withoutQueryParameters(error: unknown): unknown {
  if (!(error instanceof Error) || !('query' in error) || !('params' in error)) return error;
  const cause = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return new Error('Database query failed');
  return Object.assign(new Error(cause.message), {
    name: cause.name,
    code: (cause as { code?: unknown }).code,
    stack: cause.stack,
  });
}
