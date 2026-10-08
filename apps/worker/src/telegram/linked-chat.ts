import { type Database, telegramLinks } from '@vertex-digital/db';
import { isNull } from 'drizzle-orm';

const CACHE_MS = 60_000;

/**
 * The live link's chat (S05 rule AL1), for the alert channel: read from the database and kept for
 * 60 seconds, so an alert loop does not query on every message. Null with no link.
 */
export class LinkedChat {
  private cached: { chatId: number | null; at: number } | null = null;

  constructor(private readonly db: Database) {}

  async chatId(now = Date.now()): Promise<number | null> {
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.chatId;
    const [link] = await this.db
      .select({ chatId: telegramLinks.chatId })
      .from(telegramLinks)
      .where(isNull(telegramLinks.unlinkedAt));
    this.cached = { chatId: link?.chatId ?? null, at: now };
    return this.cached.chatId;
  }
}
