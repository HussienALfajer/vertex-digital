import type { IncomingHttpHeaders } from 'node:http';

/** Where a request came from, for audit entries and security emails. */
export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * The client address and user agent of an Express request. `request.ip` honours
 * `X-Forwarded-For` from loopback only: nginx overwrites it with the client address (ADR 0009).
 */
export function requestMeta(request: { ip?: string; headers: IncomingHttpHeaders }): RequestMeta {
  const agent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof agent === 'string' ? agent.slice(0, 500) : null,
  };
}
