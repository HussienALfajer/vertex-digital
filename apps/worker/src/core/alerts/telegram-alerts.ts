import { Logger } from '@nestjs/common';

export interface TelegramAlertsConfig {
  /** Both unset turns the channel off (development, tests, until Q11 is answered). */
  botToken?: string;
  chatId?: string;
  apiUrl: string;
  /** Prefixed to every message, so the admin group can tell the sender apart. */
  source: string;
}

/** At most this many messages a minute: Telegram's own limit for a group is 20. */
const MAX_PER_MINUTE = 15;
/** The same text is sent once in this window; repeats are counted and reported with the next. */
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10_000;
/** Telegram refuses messages over 4096 characters. */
const MAX_LENGTH = 3500;

/**
 * The admin alert channel (ADR 0002): errors and operational alerts to a Telegram group through
 * the Bot API. Rate limited and de-duplicated so an error loop cannot flood the group or get the
 * bot blocked. Sending never throws: an alert must not break the job that raised it. Messages
 * carry no secrets or personal data (ADR 0008): pass ids and error messages, never payloads.
 */
export class TelegramAlerts {
  private readonly logger = new Logger(TelegramAlerts.name);
  private readonly sentAt: number[] = [];
  private readonly lastSent = new Map<string, number>();
  private suppressed = 0;

  constructor(
    private readonly config: TelegramAlertsConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.botToken && this.config.chatId);
  }

  /** Sends `text` unless the channel is off, the text repeats, or the minute's budget is spent. */
  async send(text: string, now = Date.now()): Promise<boolean> {
    if (!this.enabled) return false;
    const last = this.lastSent.get(text);
    while (this.sentAt.length > 0 && (this.sentAt[0] ?? 0) <= now - 60_000) this.sentAt.shift();
    if (
      (last !== undefined && now - last < REPEAT_WINDOW_MS) ||
      this.sentAt.length >= MAX_PER_MINUTE
    ) {
      this.suppressed += 1;
      return false;
    }
    for (const [key, at] of this.lastSent)
      if (now - at >= REPEAT_WINDOW_MS) this.lastSent.delete(key);
    this.lastSent.set(text, now);
    this.sentAt.push(now);

    const note = this.suppressed > 0 ? `\n(${this.suppressed} more alerts suppressed)` : '';
    this.suppressed = 0;
    const message = `[${this.config.source}] ${text}`.slice(0, MAX_LENGTH) + note;
    try {
      const response = await this.fetchFn(
        `${this.config.apiUrl}/bot${this.config.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.config.chatId, text: message }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        this.logger.warn(`Telegram refused an alert: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      // The URL holds the token: log the reason only.
      this.logger.warn(`Telegram alert not sent: ${(error as Error).name}`);
      return false;
    }
  }
}
