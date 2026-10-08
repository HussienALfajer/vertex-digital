import { Logger } from '@nestjs/common';
import type { TelegramBot } from '../../telegram/bot-api.js';

export interface TelegramAlertsConfig {
  /** Prefixed to every message, so the admin can tell the sender apart. */
  source: string;
}

/** At most this many messages a minute, well under Telegram's own limits. */
const MAX_PER_MINUTE = 15;
/** The same text is sent once in this window; repeats are counted and reported with the next. */
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
/** Telegram refuses messages over 4096 characters. */
const MAX_LENGTH = 3500;

/**
 * The admin alert channel (ADR 0002, S05 rule AL1): errors and operational alerts to the linked
 * Telegram chat, read through `chatId` (cached by `LinkedChat`); with no link they are logged and
 * dropped. Rate limited and de-duplicated so an error loop cannot flood the chat or get the bot
 * blocked. Sending never throws: an alert must not break the job that raised it. Messages carry
 * no secrets or personal data (ADR 0008): pass ids and error messages, never payloads. Alerts go
 * straight to Telegram, not through the outbox: a database failure must still be reported.
 */
export class TelegramAlerts {
  private readonly logger = new Logger(TelegramAlerts.name);
  private readonly sentAt: number[] = [];
  private readonly lastSent = new Map<string, number>();
  private suppressed = 0;

  constructor(
    private readonly config: TelegramAlertsConfig,
    private readonly bot: Pick<TelegramBot, 'configured' | 'call'>,
    private readonly chatId: () => Promise<number | null>,
  ) {}

  get enabled(): boolean {
    return this.bot.configured;
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
      const chatId = await this.chatId();
      if (chatId === null) {
        this.logger.warn(`Alert not sent, no Telegram chat is linked: ${message}`);
        return false;
      }
      await this.bot.call('sendMessage', { chat_id: chatId, text: message });
      return true;
    } catch (error) {
      // Never the request: its URL holds the token.
      this.logger.warn(`Telegram alert not sent: ${(error as Error).message}`);
      return false;
    }
  }
}
