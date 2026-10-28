import { type Database, telegramLinks } from '@vertex-digital/db';
import { isNull } from 'drizzle-orm';

const CACHE_MS = 60_000;

/**
 * The live link's chat (S05 rule AL1), for the alert channel: read from the database and kept for
 * 60 seconds, so an alert loop does not query on every message. Null with no link. When the read
 * fails, the last chat read is kept: the alerts raised while the database is down are the ones
 * that matter most (audit A10-52).
 */
export class LinkedChat {
  private cached: { chatId: number | null; at: number } | null = null;

  constructor(private readonly db: Database) {}

  async chatId(now = Date.now()): Promise<number | null> {
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.chatId;
    try {
      const [link] = await this.db
        .select({ chatId: telegramLinks.chatId })
        .from(telegramLinks)
        .where(isNull(telegramLinks.unlinkedAt));
      this.cached = { chatId: link?.chatId ?? null, at: now };
    } catch (error) {
      if (this.cached?.chatId == null) throw error;
    }
    return this.cached.chatId;
  }
}
