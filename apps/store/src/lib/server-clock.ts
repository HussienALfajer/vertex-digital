/*
 * The server's clock as the browser can tell it (S03 rule FX5): a countdown to a time the server
 * set (a SYP quote's lock, a deposit's or a reservation's expiry) runs on the server's clock, not
 * the device's. A phone set minutes off would otherwise show a lock still running after the
 * server ended it, or ended while it still holds.
 */

/** The `Date` header has whole seconds: below this the device's clock is taken as right. */
const TRUSTED_SKEW_MS = 2_000;

let offsetMs = 0;

/**
 * Learns the clock from an API answer's `Date` header, with when the request left and when its
 * answer arrived. Only an answer marked `no-store` counts: a cached one keeps the `Date` of when
 * it was first sent, minutes old. The header is truncated to the second, so the server's time at
 * the answer is taken half a second after it, and the device's time half-way through the round
 * trip.
 */
export function noteServerDate(headers: Headers, sentAt: number, receivedAt: number): void {
  if (!headers.get('cache-control')?.includes('no-store')) return;
  const header = headers.get('date');
  const serverAt = header === null ? Number.NaN : Date.parse(header);
  if (!Number.isFinite(serverAt)) return;
  const skew = serverAt + 500 - (sentAt + receivedAt) / 2;
  offsetMs = Math.abs(skew) < TRUSTED_SKEW_MS ? 0 : Math.round(skew);
}

/** Now, on the server's clock, in epoch milliseconds. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}
