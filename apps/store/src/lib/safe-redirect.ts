/**
 * Accepts only same-origin paths as a post-sign-in destination, to prevent open redirects. The
 * target is resolved as the browser would: URL parsing drops tabs and line breaks, so "/\n/host"
 * would otherwise become "//host", another site.
 */
export function safeRedirect(target: unknown, origin = window.location.origin): string {
  if (typeof target !== 'string' || !target.startsWith('/')) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  if (/[\u0000-\u001f\u007f]/.test(target)) return '/';
  let resolved: URL;
  try {
    resolved = new URL(target, origin);
  } catch {
    // "//[" and the like: not a path the browser can open (2026-10-15 audit).
    return '/';
  }
  if (resolved.origin !== origin) return '/';
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * A link between the account entry screens (sign-in, sign-up, the code) that keeps where the
 * customer was heading: from the cart to sign-in, then to sign-up, the code brings them back to the
 * cart (2026-10-15 audit). Without a destination the plain path.
 */
export function withNext(path: string, next: string | null | undefined, origin?: string): string {
  // Without a destination (a page rendered on the server, before `next` is read) no `window`.
  if (!next) return path;
  const target = safeRedirect(next, origin ?? window.location.origin);
  return target === '/' ? path : `${path}?next=${encodeURIComponent(target)}`;
}
