/**
 * Failed sign-ins per email in a sliding window, so password guessing spread over many
 * addresses is slowed too (ADR 0007). Memory is enough for one API process.
 */
export class SignInFailures {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

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
    this.failures.set(email, [...this.recent(email, now), now]);
  }

  clear(email: string): void {
    this.failures.delete(email);
  }
}
