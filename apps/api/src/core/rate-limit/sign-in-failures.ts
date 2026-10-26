/**
 * Failed sign-ins per email in a sliding window, so password guessing spread over many
 * addresses is slowed too (ADR 0007). Memory is enough for one API process; it holds at most
 * `maxEmails` emails, so sign-ins sprayed over endless made-up emails cannot grow it without bound
 * (audit A01-4).
 */
export class SignInFailures {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEmails = 10_000,
  ) {}

  /** How many emails are held (for tests). */
  get size(): number {
    return this.failures.size;
  }

  private recent(email: string, now: number): number[] {
    const kept = (this.failures.get(email) ?? []).filter((at) => at > now - this.windowMs);
    if (kept.length > 0) this.failures.set(email, kept);
    else this.failures.delete(email);
    return kept;
  }

  blocked(email: string, now = Date.now()): boolean {
    return this.recent(email, now).length >= this.limit;
  }

  fail(email: string, now = Date.now()): void {
    const kept = this.recent(email, now);
    // Written again at the end, so the map's order is the order of the last failure.
    this.failures.delete(email);
    this.failures.set(email, [...kept, now]);
    if (this.failures.size > this.maxEmails) this.prune(now);
  }

  clear(email: string): void {
    this.failures.delete(email);
  }

  /**
   * Emails out of the window go first, then those still below the limit, oldest first, so a spray
   * cannot wash out an email that asks for the ALTCHA; blocked ones go last.
   */
  private prune(now: number): void {
    for (const [email, times] of this.failures) {
      if (!times.some((at) => at > now - this.windowMs)) this.failures.delete(email);
    }
    for (const [email, times] of this.failures) {
      if (this.failures.size <= this.maxEmails) return;
      if (times.length < this.limit) this.failures.delete(email);
    }
    for (const email of this.failures.keys()) {
      if (this.failures.size <= this.maxEmails) return;
      this.failures.delete(email);
    }
  }
}
