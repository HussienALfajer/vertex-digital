import { Inject, Injectable } from '@nestjs/common';
import {
  ANNOUNCEMENTS_MAX,
  type Announcement,
  type AnnouncementInput,
  announcementState,
  BANNER_MIN_HEIGHT,
  BANNER_MIN_WIDTH,
  BANNER_RATIO,
  BANNER_RATIO_TOLERANCE,
  BANNERS_ENABLED_MAX,
  BANNERS_MAX,
  type Banner,
  type BannerImage,
  type BannerInput,
  bannerState,
  type EnabledAnnouncement,
  type SiteContent,
} from '@vertex-digital/contracts';
import { announcements, banners, type Database, type Transaction } from '@vertex-digital/db';
import { and, asc, count, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import { FilesService } from '../files/index.js';
import { ContentFaqService } from './content-faq.service.js';
import { ContentPagesService } from './content-pages.service.js';
import {
  type Actor,
  type AnnouncementRow,
  announcementValues,
  audit,
  type BannerRow,
  bannerValues,
  checkSchedule,
  refusals,
  toAnnouncement,
  toBanner,
} from './content-records.js';

/** Advisory locks serializing banner and announcement changes (limits, order, the one enabled). */
const BANNERS_LOCK = 'content:banners';
const ANNOUNCEMENTS_LOCK = 'content:announcements';

const lock = (tx: Transaction, key: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

/**
 * Home banners (S14 BN1–BN6), the announcement bar (AN1–AN4) and the store's site content: what
 * every store page may show.
 */
@Injectable()
export class ContentHomeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly files: FilesService,
    private readonly pages: ContentPagesService,
    private readonly faq: ContentFaqService,
  ) {}

  /** `GET /api/content/site` (CP3): only what the store shows. */
  async site(now = new Date()): Promise<SiteContent> {
    const [enabledAnnouncements, enabledBanners, pages, faqPublished] = await Promise.all([
      this.db
        .select()
        .from(announcements)
        .where(and(eq(announcements.enabled, true), isNull(announcements.archivedAt))),
      this.db
        .select()
        .from(banners)
        .where(and(eq(banners.enabled, true), isNull(banners.archivedAt)))
        .orderBy(asc(banners.position)),
      this.pages.publishedTitles(),
      this.faq.isPublished(),
    ]);
    const announcement = enabledAnnouncements.find((row) => announcementState(row, now) === 'live');
    return {
      announcement: announcement
        ? {
            id: announcement.id,
            revision: announcement.revision,
            text: announcement.text,
            linkPath: announcement.linkPath,
            tone: announcement.tone,
          }
        : null,
      banners: enabledBanners
        .filter((row) => bannerState(row, now) === 'live')
        .slice(0, BANNERS_ENABLED_MAX)
        .map((row) => ({
          id: row.id,
          imageId: row.imageFileId,
          altText: row.altText,
          linkPath: row.linkPath,
        })),
      pages,
      faqPublished,
    };
  }

  // Banners ---------------------------------------------------------------------------------------

  /**
   * Rule BN2: a catalog image of at least 1200 × 600 px and a 2:1 ratio within 2%, checked before
   * the file is written (audit A08-2).
   */
  async uploadBannerImage(upload: Buffer | undefined): Promise<BannerImage> {
    const prepared = await this.files.prepare('catalog_image', upload, ({ width, height }) => {
      if (width < BANNER_MIN_WIDTH || height < BANNER_MIN_HEIGHT) {
        throw imageRefused('too_small');
      }
      if (Math.abs(width / height - BANNER_RATIO) > BANNER_RATIO * BANNER_RATIO_TOLERANCE) {
        throw imageRefused('ratio');
      }
    });
    await this.db.transaction((tx) => this.files.record(tx, prepared));
    return {
      fileId: prepared.row.id,
      width: prepared.row.width as number,
      height: prepared.row.height as number,
    };
  }

  async banners(archived: boolean, now = new Date()): Promise<Banner[]> {
    const rows = await this.db
      .select()
      .from(banners)
      .where(archived ? undefined : isNull(banners.archivedAt))
      .orderBy(asc(sql`${banners.archivedAt} is not null`), asc(banners.position));
    return rows.map((row) => toBanner(row, now));
  }

  async createBanner(actor: Actor, input: BannerInput, now = new Date()): Promise<Banner> {
    await this.checkImage(input.imageFileId);
    const schedule = checkSchedule(input, null, now);
    return this.db.transaction(async (tx) => {
      await lock(tx, BANNERS_LOCK);
      if ((await this.liveBanners(tx)) >= BANNERS_MAX) throw refusals.limit(BANNERS_MAX);
      const [row] = await tx
        .insert(banners)
        .values({
          imageFileId: input.imageFileId,
          altText: input.altText,
          linkPath: input.linkPath ?? null,
          ...schedule,
          position: await this.nextBannerPosition(tx),
        })
        .returning();
      const banner = row as BannerRow;
      await audit(tx, actor, 'banner.created', bannerEntity(banner), {
        before: {},
        after: bannerValues(banner),
      });
      return toBanner(banner, now);
    });
  }

  async updateBanner(
    actor: Actor,
    id: string,
    input: BannerInput,
    now = new Date(),
  ): Promise<Banner> {
    await this.checkImage(input.imageFileId);
    return this.db.transaction(async (tx) => {
      await lock(tx, BANNERS_LOCK);
      const before = await this.banner(tx, id);
      const schedule = checkSchedule(input, before, now);
      const [row] = await tx
        .update(banners)
        .set({
          imageFileId: input.imageFileId,
          altText: input.altText,
          linkPath: input.linkPath ?? null,
          ...schedule,
        })
        .where(eq(banners.id, id))
        .returning();
      return this.audited(tx, actor, 'banner.updated', before, row as BannerRow, now);
    });
  }

  /** Rule BN3: at most 5 enabled; an archived banner is restored first. */
  async enableBanner(actor: Actor, id: string, now = new Date()): Promise<Banner> {
    return this.db.transaction(async (tx) => {
      await lock(tx, BANNERS_LOCK);
      const before = await this.banner(tx, id);
      if (before.enabled) return toBanner(before, now);
      if (before.archivedAt !== null) throw refusals.invalid(['id'], 'The banner is archived');
      const [enabled] = await tx
        .select({ count: count() })
        .from(banners)
        .where(and(eq(banners.enabled, true), isNull(banners.archivedAt)));
      if ((enabled?.count ?? 0) >= BANNERS_ENABLED_MAX) throw refusals.limit(BANNERS_ENABLED_MAX);
      const [row] = await tx
        .update(banners)
        .set({ enabled: true })
        .where(eq(banners.id, id))
        .returning();
      return this.audited(tx, actor, 'banner.enabled', before, row as BannerRow, now);
    });
  }

  async disableBanner(actor: Actor, id: string, now = new Date()): Promise<Banner> {
    return this.db.transaction(async (tx) => {
      await lock(tx, BANNERS_LOCK);
      const before = await this.banner(tx, id);
      if (!before.enabled) return toBanner(before, now);
      const [row] = await tx
        .update(banners)
        .set({ enabled: false })
        .where(eq(banners.id, id))
        .returning();
      return this.audited(tx, actor, 'banner.disabled', before, row as BannerRow, now);
    });
  }

  /** Rule BN5: archiving an enabled banner disables it in the same change. */
  async archiveBanner(actor: Actor, id: string, now = new Date()): Promise<Banner> {
    return this.db.transaction(async (tx) => {
      await lock(tx, BANNERS_LOCK);
      const before = await this.banner(tx, id);
      if (before.archivedAt !== null) return toBanner(before, now);
      const [row] = await tx
        .update(banners)
        .set({ enabled: false, archivedAt: sql`now()` })
        .where(eq(banners.id, id))
        .returning();
      return this.audited(tx, actor, 'banner.archived', before, row as BannerRow, now);
    });
  }

  /** Rule BN5: back disabled, last in the order, within the 20 unarchived. */
  async restoreBanner(actor: Actor, id: string, now = new Date()): Promise<Banner> {
    return this.db.transaction(async (tx) => {
      await lock(tx, BANNERS_LOCK);
      const before = await this.banner(tx, id);
      if (before.archivedAt === null) return toBanner(before, now);
      if ((await this.liveBanners(tx)) >= BANNERS_MAX) throw refusals.limit(BANNERS_MAX);
      const [row] = await tx
        .update(banners)
        .set({ archivedAt: null, enabled: false, position: await this.nextBannerPosition(tx) })
        .where(eq(banners.id, id))
        .returning();
      return this.audited(tx, actor, 'banner.restored', before, row as BannerRow, now);
    });
  }

  /** Rule BN6: every unarchived banner, once, in the new order. */
  async reorderBanners(actor: Actor, ids: string[], now = new Date()): Promise<Banner[]> {
    await this.db.transaction(async (tx) => {
      await lock(tx, BANNERS_LOCK);
      const live = await tx
        .select({ id: banners.id })
        .from(banners)
        .where(isNull(banners.archivedAt));
      const known = new Set(live.map((row) => row.id));
      if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
        throw refusals.invalid(['ids'], 'Expected every unarchived banner once');
      }
      for (const [index, id] of ids.entries()) {
        await tx
          .update(banners)
          .set({ position: index + 1 })
          .where(eq(banners.id, id));
      }
      await audit(tx, actor, 'banner.reordered', { type: 'banner', id: ids[0] as string }, { ids });
    });
    return this.banners(false, now);
  }

  private async audited(
    tx: Transaction,
    actor: Actor,
    action:
      | 'banner.updated'
      | 'banner.enabled'
      | 'banner.disabled'
      | 'banner.archived'
      | 'banner.restored',
    before: BannerRow,
    after: BannerRow,
    now: Date,
  ): Promise<Banner> {
    await audit(tx, actor, action, bannerEntity(after), {
      before: bannerValues(before),
      after: bannerValues(after),
    });
    return toBanner(after, now);
  }

  /** Edge case 8: any catalog image may be a banner; the ratio is checked at upload only. */
  private async checkImage(fileId: string): Promise<void> {
    if ((await this.files.dimensions([fileId], 'catalog_image')).size === 0) {
      throw refusals.invalid(['imageFileId'], 'Expected an uploaded banner image');
    }
  }

  private async liveBanners(tx: Transaction): Promise<number> {
    const [row] = await tx
      .select({ count: count() })
      .from(banners)
      .where(isNull(banners.archivedAt));
    return row?.count ?? 0;
  }

  private async nextBannerPosition(tx: Transaction): Promise<number> {
    const [row] = await tx
      .select({ last: max(banners.position) })
      .from(banners)
      .where(isNull(banners.archivedAt));
    return (row?.last ?? 0) + 1;
  }

  private async banner(tx: Transaction, id: string): Promise<BannerRow> {
    const [row] = await tx.select().from(banners).where(eq(banners.id, id)).for('update');
    if (!row) throw refusals.notFound('banner');
    return row;
  }

  // Announcements ---------------------------------------------------------------------------------

  async announcements(archived: boolean, now = new Date()): Promise<Announcement[]> {
    const rows = await this.db
      .select()
      .from(announcements)
      .where(archived ? undefined : isNull(announcements.archivedAt))
      .orderBy(
        asc(sql`${announcements.archivedAt} is not null`),
        desc(announcements.enabled),
        desc(announcements.createdAt),
      );
    return rows.map((row) => toAnnouncement(row, now));
  }

  async createAnnouncement(
    actor: Actor,
    input: AnnouncementInput,
    now = new Date(),
  ): Promise<Announcement> {
    const schedule = checkSchedule(input, null, now);
    return this.db.transaction(async (tx) => {
      await lock(tx, ANNOUNCEMENTS_LOCK);
      if ((await this.liveAnnouncements(tx)) >= ANNOUNCEMENTS_MAX) {
        throw refusals.limit(ANNOUNCEMENTS_MAX);
      }
      const [row] = await tx
        .insert(announcements)
        .values({
          text: input.text,
          linkPath: input.linkPath ?? null,
          tone: input.tone ?? 'info',
          ...schedule,
        })
        .returning();
      const announcement = row as AnnouncementRow;
      await audit(tx, actor, 'announcement.created', announcementEntity(announcement), {
        before: {},
        after: announcementValues(announcement),
      });
      return toAnnouncement(announcement, now);
    });
  }

  /** Rule AN4: a new text, link or tone increments the revision; a schedule alone does not. */
  async updateAnnouncement(
    actor: Actor,
    id: string,
    input: AnnouncementInput,
    now = new Date(),
  ): Promise<Announcement> {
    return this.db.transaction(async (tx) => {
      await lock(tx, ANNOUNCEMENTS_LOCK);
      const before = await this.announcement(tx, id);
      const schedule = checkSchedule(input, before, now);
      const values = {
        text: input.text,
        linkPath: input.linkPath ?? null,
        tone: input.tone ?? 'info',
      };
      const shown =
        values.text !== before.text ||
        values.linkPath !== before.linkPath ||
        values.tone !== before.tone;
      const [row] = await tx
        .update(announcements)
        .set({ ...values, ...schedule, ...(shown ? { revision: before.revision + 1 } : {}) })
        .where(eq(announcements.id, id))
        .returning();
      return this.announced(tx, actor, 'announcement.updated', before, row as AnnouncementRow, now);
    });
  }

  /** Rule AN2: enabling one disables the enabled one in the same change, both audited. */
  async enableAnnouncement(
    actor: Actor,
    id: string,
    now = new Date(),
  ): Promise<EnabledAnnouncement> {
    try {
      return await this.db.transaction(async (tx) => {
        await lock(tx, ANNOUNCEMENTS_LOCK);
        const before = await this.announcement(tx, id);
        if (before.archivedAt !== null) {
          throw refusals.invalid(['id'], 'The announcement is archived');
        }
        if (before.enabled) return { ...toAnnouncement(before, now), replaced: null };
        const [current] = await tx
          .select()
          .from(announcements)
          .where(and(eq(announcements.enabled, true), isNull(announcements.archivedAt)))
          .for('update');
        if (current) {
          const [off] = await tx
            .update(announcements)
            .set({ enabled: false })
            .where(eq(announcements.id, current.id))
            .returning();
          await this.announced(
            tx,
            actor,
            'announcement.disabled',
            current,
            off as AnnouncementRow,
            now,
          );
        }
        const [row] = await tx
          .update(announcements)
          .set({ enabled: true })
          .where(eq(announcements.id, id))
          .returning();
        const enabled = await this.announced(
          tx,
          actor,
          'announcement.enabled',
          before,
          row as AnnouncementRow,
          now,
        );
        return {
          ...enabled,
          replaced: current ? { id: current.id, text: current.text } : null,
        };
      });
    } catch (error) {
      // Edge case 11: another enable won the one-enabled index.
      if (isUniqueViolation(error)) throw refusals.stale();
      throw error;
    }
  }

  async disableAnnouncement(actor: Actor, id: string, now = new Date()): Promise<Announcement> {
    return this.db.transaction(async (tx) => {
      await lock(tx, ANNOUNCEMENTS_LOCK);
      const before = await this.announcement(tx, id);
      if (!before.enabled) return toAnnouncement(before, now);
      const [row] = await tx
        .update(announcements)
        .set({ enabled: false })
        .where(eq(announcements.id, id))
        .returning();
      return this.announced(
        tx,
        actor,
        'announcement.disabled',
        before,
        row as AnnouncementRow,
        now,
      );
    });
  }

  async archiveAnnouncement(actor: Actor, id: string, now = new Date()): Promise<Announcement> {
    return this.db.transaction(async (tx) => {
      await lock(tx, ANNOUNCEMENTS_LOCK);
      const before = await this.announcement(tx, id);
      if (before.archivedAt !== null) return toAnnouncement(before, now);
      const [row] = await tx
        .update(announcements)
        .set({ enabled: false, archivedAt: sql`now()` })
        .where(eq(announcements.id, id))
        .returning();
      return this.announced(
        tx,
        actor,
        'announcement.archived',
        before,
        row as AnnouncementRow,
        now,
      );
    });
  }

  async restoreAnnouncement(actor: Actor, id: string, now = new Date()): Promise<Announcement> {
    return this.db.transaction(async (tx) => {
      await lock(tx, ANNOUNCEMENTS_LOCK);
      const before = await this.announcement(tx, id);
      if (before.archivedAt === null) return toAnnouncement(before, now);
      if ((await this.liveAnnouncements(tx)) >= ANNOUNCEMENTS_MAX) {
        throw refusals.limit(ANNOUNCEMENTS_MAX);
      }
      const [row] = await tx
        .update(announcements)
        .set({ archivedAt: null, enabled: false })
        .where(eq(announcements.id, id))
        .returning();
      return this.announced(
        tx,
        actor,
        'announcement.restored',
        before,
        row as AnnouncementRow,
        now,
      );
    });
  }

  private async announced(
    tx: Transaction,
    actor: Actor,
    action:
      | 'announcement.updated'
      | 'announcement.enabled'
      | 'announcement.disabled'
      | 'announcement.archived'
      | 'announcement.restored',
    before: AnnouncementRow,
    after: AnnouncementRow,
    now: Date,
  ): Promise<Announcement> {
    await audit(tx, actor, action, announcementEntity(after), {
      before: announcementValues(before),
      after: announcementValues(after),
    });
    return toAnnouncement(after, now);
  }

  private async liveAnnouncements(tx: Transaction): Promise<number> {
    const [row] = await tx
      .select({ count: count() })
      .from(announcements)
      .where(isNull(announcements.archivedAt));
    return row?.count ?? 0;
  }

  private async announcement(tx: Transaction, id: string): Promise<AnnouncementRow> {
    const [row] = await tx
      .select()
      .from(announcements)
      .where(eq(announcements.id, id))
      .for('update');
    if (!row) throw refusals.notFound('announcement');
    return row;
  }
}

const bannerEntity = (row: BannerRow) => ({ type: 'banner' as const, id: row.id });
const announcementEntity = (row: AnnouncementRow) => ({
  type: 'announcement' as const,
  id: row.id,
});

const imageRefused = (reason: 'too_small' | 'ratio') =>
  new CodedException(
    400,
    'IMAGE_INVALID',
    reason === 'too_small'
      ? 'A banner is at least 1200 × 600 px'
      : 'A banner is twice as wide as it is high',
    { reason },
  );
