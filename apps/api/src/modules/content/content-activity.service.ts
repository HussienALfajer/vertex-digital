import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_MINIMUM,
  type Activity,
  type ActivityItem,
  type AdminActivity,
  activityVisible,
  type ContentSettings,
  floorToFiveMinutes,
} from '@vertex-digital/contracts';
import { type ActivityRow, contentSettings, type Database, liveActivity } from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { type Actor, audit, SETTINGS_ENTITY_ID } from './content-records.js';

/**
 * Live activity (S14 LA1–LA7) from `packages/db`, which reads the orders and catalog for this
 * module, and its switch in `content_settings`.
 */
@Injectable()
export class ContentActivityService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** `GET /api/content/activity`: no items while off (LA6) or below the minimum (LA3). */
  async activity(gameSlug: string | undefined, now = new Date()): Promise<Activity> {
    if (!(await this.settings()).liveActivityEnabled) return { items: [] };
    const feed = await liveActivity(this.db, { now, ...(gameSlug ? { gameSlug } : {}) });
    return { items: activityVisible(feed.count) ? feed.items.map(toItem) : [] };
  }

  /** `GET /api/admin/content/activity`: the store-wide feed as the store would show it. */
  async preview(now = new Date()): Promise<AdminActivity> {
    const [settings, feed] = await Promise.all([this.settings(), liveActivity(this.db, { now })]);
    const visible = activityVisible(feed.count);
    return {
      enabled: settings.liveActivityEnabled,
      qualifyingLast24h: feed.count,
      minimum: ACTIVITY_MINIMUM,
      visible,
      items: visible ? feed.items.map(toItem) : [],
    };
  }

  async settings(): Promise<ContentSettings> {
    const [row] = await this.db
      .select({ liveActivityEnabled: contentSettings.liveActivityEnabled })
      .from(contentSettings);
    return { liveActivityEnabled: row?.liveActivityEnabled ?? true };
  }

  /** Rule LA6: audited with before and after. */
  async updateSettings(actor: Actor, input: ContentSettings): Promise<ContentSettings> {
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ liveActivityEnabled: contentSettings.liveActivityEnabled })
        .from(contentSettings)
        .for('update');
      await tx
        .update(contentSettings)
        .set({ liveActivityEnabled: input.liveActivityEnabled, updatedAt: sql`now()` });
      await audit(
        tx,
        actor,
        'content_settings.set',
        { type: 'content_settings', id: SETTINGS_ENTITY_ID },
        {
          before: { liveActivityEnabled: before?.liveActivityEnabled ?? true },
          after: { liveActivityEnabled: input.liveActivityEnabled },
        },
      );
    });
    return this.settings();
  }
}

/** Rule LA2, LA4: only these fields, the time floored to 5 minutes. */
function toItem(row: ActivityRow): ActivityItem {
  return {
    gameSlug: row.gameSlug,
    gameNameAr: row.gameNameAr,
    productNameAr: row.productNameAr,
    quantity: row.quantity,
    durationSeconds: row.durationSeconds,
    deliveredAt: floorToFiveMinutes(row.deliveredAt).toISOString(),
  };
}
