/**
 * Accepts only same-origin paths as a post-sign-in destination, to prevent open redirects. The
 * target is resolved as the browser would: URL parsing drops tabs and line breaks, so "/\n/host"
 * would otherwise become "//host", another site.
 */
export function safeRedirect(target: unknown, origin = window.location.origin): string {
  if (typeof target !== 'string' || !target.startsWith('/')) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  if (/[\u0000-\u001f\u007f]/.test(target)) return '/';
  const resolved = new URL(target, origin);
  if (resolved.origin !== origin) return '/';
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
