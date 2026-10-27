import { Inject, Injectable } from '@nestjs/common';
import {
  FAQ_ITEMS_PER_SECTION_MAX,
  FAQ_SECTIONS_MAX,
  type FaqItem,
  type FaqOrder,
  type FaqPublication,
  type FaqSection,
  type FaqSnapshot,
  type FaqWorkingCopy,
  faqSnapshotSchema,
  type PublishedFaq,
  type SaveFaqItem,
  type SaveFaqSection,
} from '@vertex-digital/contracts';
import {
  contentSettings,
  type Database,
  faqItems,
  faqPublications,
  faqSections,
  queueStoreRevalidate,
  readAll,
  type Transaction,
} from '@vertex-digital/db';
import { and, asc, count, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { JobsService } from '../../core/jobs/index.js';
import {
  type Actor,
  audit,
  bumpFaqRevision,
  FAQ_ENTITY_ID,
  type FaqItemRow,
  type FaqSectionRow,
  lockFaqRevision,
  refusals,
  toFaqItem,
  toFaqSection,
} from './content-records.js';

type PublicationRow = typeof faqPublications.$inferSelect;

/**
 * The FAQ (S14 FQ1–FQ7): a working copy of sections and questions edited freely, each change
 * incrementing the working revision under the settings row's lock, and published as one snapshot.
 */
@Injectable()
export class ContentFaqService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
  ) {}

  /** `GET /api/admin/content/faq`: sections and questions in order; archived ones when asked. */
  async workingCopy(
    archived: boolean,
    executor: Database | Transaction = this.db,
  ): Promise<FaqWorkingCopy> {
    const [[settings], sections, items, [newest]] = await readAll(executor, [
      () => executor.select({ revision: contentSettings.faqRevision }).from(contentSettings),
      () =>
        executor
          .select()
          .from(faqSections)
          .where(archived ? undefined : isNull(faqSections.archivedAt))
          .orderBy(asc(sql`${faqSections.archivedAt} is not null`), asc(faqSections.position)),
      () =>
        executor
          .select()
          .from(faqItems)
          .where(archived ? undefined : isNull(faqItems.archivedAt))
          .orderBy(asc(sql`${faqItems.archivedAt} is not null`), asc(faqItems.position)),
      () =>
        executor.select().from(faqPublications).orderBy(desc(faqPublications.publishedAt)).limit(1),
    ]);
    const changedAt = [...sections, ...items].reduce<Date | null>(
      (latest, row) => (latest === null || row.updatedAt > latest ? row.updatedAt : latest),
      null,
    );
    return {
      revision: settings?.revision ?? 0,
      changedAt: changedAt?.toISOString() ?? null,
      sections: sections.map((section) => ({
        ...toFaqSection(section),
        items: items.filter((item) => item.sectionId === section.id).map(toFaqItem),
      })),
      publication: newest ? publicationOf(newest) : null,
    };
  }

  async createSection(actor: Actor, input: SaveFaqSection): Promise<FaqSection> {
    return this.db.transaction(async (tx) => {
      await bumpFaqRevision(tx);
      if ((await this.liveSections(tx)) >= FAQ_SECTIONS_MAX) throw refusals.limit(FAQ_SECTIONS_MAX);
      const [row] = await tx
        .insert(faqSections)
        .values({ title: input.title, position: await this.nextSectionPosition(tx) })
        .returning();
      const section = row as FaqSectionRow;
      await audit(tx, actor, 'faq_section.created', sectionEntity(section), {
        before: {},
        after: { title: section.title },
      });
      return toFaqSection(section);
    });
  }

  async updateSection(actor: Actor, id: string, input: SaveFaqSection): Promise<FaqSection> {
    return this.db.transaction(async (tx) => {
      await bumpFaqRevision(tx);
      const before = await this.section(tx, id);
      const [row] = await tx
        .update(faqSections)
        .set({ title: input.title })
        .where(eq(faqSections.id, id))
        .returning();
      const section = row as FaqSectionRow;
      await audit(tx, actor, 'faq_section.updated', sectionEntity(section), {
        before: { title: before.title },
        after: { title: section.title },
      });
      return toFaqSection(section);
    });
  }

  /** Rule FQ3: hidden with its questions from the next publication; their own state kept. */
  async archiveSection(actor: Actor, id: string): Promise<FaqSection> {
    return this.db.transaction(async (tx) => {
      await lockFaqRevision(tx);
      const before = await this.section(tx, id);
      if (before.archivedAt !== null) return toFaqSection(before);
      await bumpFaqRevision(tx);
      const [row] = await tx
        .update(faqSections)
        .set({ archivedAt: sql`now()` })
        .where(eq(faqSections.id, id))
        .returning();
      await audit(tx, actor, 'faq_section.archived', sectionEntity(before), {
        before: { title: before.title },
        after: { title: before.title },
      });
      return toFaqSection(row as FaqSectionRow);
    });
  }

  /** Rule FQ3: under the section limit, last in the order. */
  async restoreSection(actor: Actor, id: string): Promise<FaqSection> {
    return this.db.transaction(async (tx) => {
      await lockFaqRevision(tx);
      const before = await this.section(tx, id);
      if (before.archivedAt === null) return toFaqSection(before);
      await bumpFaqRevision(tx);
      if ((await this.liveSections(tx)) >= FAQ_SECTIONS_MAX) throw refusals.limit(FAQ_SECTIONS_MAX);
      const [row] = await tx
        .update(faqSections)
        .set({ archivedAt: null, position: await this.nextSectionPosition(tx) })
        .where(eq(faqSections.id, id))
        .returning();
      await audit(tx, actor, 'faq_section.restored', sectionEntity(before), {
        before: { title: before.title },
        after: { title: before.title },
      });
      return toFaqSection(row as FaqSectionRow);
    });
  }

  async createItem(actor: Actor, input: SaveFaqItem): Promise<FaqItem> {
    return this.db.transaction(async (tx) => {
      await bumpFaqRevision(tx);
      await this.liveSection(tx, input.sectionId);
      await this.checkItemRoom(tx, input.sectionId);
      const [row] = await tx
        .insert(faqItems)
        .values({
          sectionId: input.sectionId,
          question: input.question,
          answer: input.answer,
          position: await this.nextItemPosition(tx, input.sectionId),
        })
        .returning();
      const item = row as FaqItemRow;
      await audit(tx, actor, 'faq_item.created', itemEntity(item), {
        before: {},
        after: itemValues(item),
      });
      return toFaqItem(item);
    });
  }

  /** Rule FQ3: a question moved to another unarchived section is placed last there. */
  async updateItem(actor: Actor, id: string, input: SaveFaqItem): Promise<FaqItem> {
    return this.db.transaction(async (tx) => {
      await bumpFaqRevision(tx);
      const before = await this.item(tx, id);
      const moved = before.sectionId !== input.sectionId;
      if (moved) {
        await this.liveSection(tx, input.sectionId);
        if (before.archivedAt === null) await this.checkItemRoom(tx, input.sectionId);
      }
      const [row] = await tx
        .update(faqItems)
        .set({
          sectionId: input.sectionId,
          question: input.question,
          answer: input.answer,
          ...(moved ? { position: await this.nextItemPosition(tx, input.sectionId) } : {}),
        })
        .where(eq(faqItems.id, id))
        .returning();
      const item = row as FaqItemRow;
      await audit(tx, actor, 'faq_item.updated', itemEntity(item), {
        before: itemValues(before),
        after: itemValues(item),
      });
      return toFaqItem(item);
    });
  }

  async archiveItem(actor: Actor, id: string): Promise<FaqItem> {
    return this.db.transaction(async (tx) => {
      await lockFaqRevision(tx);
      const before = await this.item(tx, id);
      if (before.archivedAt !== null) return toFaqItem(before);
      await bumpFaqRevision(tx);
      const [row] = await tx
        .update(faqItems)
        .set({ archivedAt: sql`now()` })
        .where(eq(faqItems.id, id))
        .returning();
      await audit(tx, actor, 'faq_item.archived', itemEntity(before), {
        before: itemValues(before),
        after: itemValues(before),
      });
      return toFaqItem(row as FaqItemRow);
    });
  }

  /** Rule FQ3: under an unarchived section, within its limit, last in its order. */
  async restoreItem(actor: Actor, id: string): Promise<FaqItem> {
    return this.db.transaction(async (tx) => {
      await lockFaqRevision(tx);
      const before = await this.item(tx, id);
      if (before.archivedAt === null) return toFaqItem(before);
      await bumpFaqRevision(tx);
      await this.liveSection(tx, before.sectionId);
      await this.checkItemRoom(tx, before.sectionId);
      const [row] = await tx
        .update(faqItems)
        .set({ archivedAt: null, position: await this.nextItemPosition(tx, before.sectionId) })
        .where(eq(faqItems.id, id))
        .returning();
      await audit(tx, actor, 'faq_item.restored', itemEntity(before), {
        before: itemValues(before),
        after: itemValues(before),
      });
      return toFaqItem(row as FaqItemRow);
    });
  }

  /** Rule FQ4: exactly the unarchived sections and, per section, its unarchived questions. */
  async reorder(actor: Actor, order: FaqOrder): Promise<FaqWorkingCopy> {
    return this.db.transaction(async (tx) => {
      await bumpFaqRevision(tx);
      const current = await this.workingCopy(false, tx);
      const expected = current.sections.map((section) => ({
        id: section.id,
        itemIds: new Set(section.items.map((item) => item.id)),
      }));
      const matches =
        order.sections.length === expected.length &&
        order.sections.every((section) => {
          const known = expected.find((candidate) => candidate.id === section.id);
          return (
            known !== undefined &&
            known.itemIds.size === section.itemIds.length &&
            section.itemIds.every((itemId) => known.itemIds.has(itemId))
          );
        });
      if (!matches) {
        throw refusals.invalid(['sections'], 'Expected every unarchived section and question once');
      }
      for (const [sectionIndex, section] of order.sections.entries()) {
        await tx
          .update(faqSections)
          .set({ position: sectionIndex + 1 })
          .where(eq(faqSections.id, section.id));
        for (const [itemIndex, itemId] of section.itemIds.entries()) {
          await tx
            .update(faqItems)
            .set({ position: itemIndex + 1 })
            .where(eq(faqItems.id, itemId));
        }
      }
      await audit(
        tx,
        actor,
        'faq.reordered',
        { type: 'faq', id: FAQ_ENTITY_ID },
        { sections: order.sections },
      );
      return this.workingCopy(false, tx);
    });
  }

  /** Rule FQ6: the previewed revision becomes the published snapshot (FQ5). */
  async publish(actor: Actor, revision: number): Promise<FaqPublication> {
    return this.db.transaction(async (tx) => {
      const [settings] = await tx
        .select({ revision: contentSettings.faqRevision })
        .from(contentSettings)
        .for('update');
      if (settings?.revision !== revision) throw refusals.stale();
      const [newest] = await tx
        .select({ revision: faqPublications.faqRevision })
        .from(faqPublications)
        .orderBy(desc(faqPublications.publishedAt))
        .limit(1);
      if (newest?.revision === revision) throw refusals.unchanged();
      const current = await this.workingCopy(false, tx);
      const snapshot: FaqSnapshot = current.sections
        .filter((section) => section.items.length > 0)
        .map((section) => ({
          id: section.id,
          title: section.title,
          items: section.items.map((item) => ({
            id: item.id,
            question: item.question,
            answer: item.answer,
          })),
        }));
      const [row] = await tx
        .insert(faqPublications)
        .values({ faqRevision: revision, sections: snapshot, adminId: actor.adminId })
        .returning();
      const publication = publicationOf(row as PublicationRow);
      await audit(
        tx,
        actor,
        'faq.published',
        { type: 'faq', id: FAQ_ENTITY_ID },
        { revision, sections: publication.sections, items: publication.items },
      );
      await queueStoreRevalidate(tx, this.jobs);
      return publication;
    });
  }

  /** `GET /api/content/faq` (FQ5): the newest publication; none, or one with no question, is 404. */
  async published(): Promise<PublishedFaq> {
    const newest = await this.newestPublication();
    if (!newest) throw refusals.notFound('FAQ');
    return { sections: newest.sections, updatedAt: newest.publishedAt.toISOString() };
  }

  /**
   * Whether the store links to `/faq` (SL1, SL3): the newest publication holds a question, asked
   * of the database rather than parsing the snapshot (audit A08-3).
   */
  async isPublished(): Promise<boolean> {
    const [row] = await this.db
      .select({
        published: sql<boolean>`jsonb_path_exists(${faqPublications.sections}, '$[*].items[0]')`,
      })
      .from(faqPublications)
      .orderBy(desc(faqPublications.publishedAt))
      .limit(1);
    return row?.published ?? false;
  }

  private async newestPublication() {
    const [row] = await this.db
      .select()
      .from(faqPublications)
      .orderBy(desc(faqPublications.publishedAt))
      .limit(1);
    if (!row) return null;
    const sections = faqSnapshotSchema.parse(row.sections);
    if (sections.every((section) => section.items.length === 0)) return null;
    return { sections, publishedAt: row.publishedAt };
  }

  private async liveSections(tx: Transaction): Promise<number> {
    const [row] = await tx
      .select({ count: count() })
      .from(faqSections)
      .where(isNull(faqSections.archivedAt));
    return row?.count ?? 0;
  }

  private async checkItemRoom(tx: Transaction, sectionId: string): Promise<void> {
    const [row] = await tx
      .select({ count: count() })
      .from(faqItems)
      .where(and(eq(faqItems.sectionId, sectionId), isNull(faqItems.archivedAt)));
    if ((row?.count ?? 0) >= FAQ_ITEMS_PER_SECTION_MAX) {
      throw refusals.limit(FAQ_ITEMS_PER_SECTION_MAX);
    }
  }

  private async nextSectionPosition(tx: Transaction): Promise<number> {
    const [row] = await tx
      .select({ last: max(faqSections.position) })
      .from(faqSections)
      .where(isNull(faqSections.archivedAt));
    return (row?.last ?? 0) + 1;
  }

  private async nextItemPosition(tx: Transaction, sectionId: string): Promise<number> {
    const [row] = await tx
      .select({ last: max(faqItems.position) })
      .from(faqItems)
      .where(and(eq(faqItems.sectionId, sectionId), isNull(faqItems.archivedAt)));
    return (row?.last ?? 0) + 1;
  }

  private async section(tx: Transaction, id: string): Promise<FaqSectionRow> {
    const [row] = await tx.select().from(faqSections).where(eq(faqSections.id, id));
    if (!row) throw refusals.notFound('FAQ section');
    return row;
  }

  /** The section a question goes under: unarchived, or `PARENT_ARCHIVED`. */
  private async liveSection(tx: Transaction, id: string): Promise<FaqSectionRow> {
    const row = await this.section(tx, id);
    if (row.archivedAt !== null) throw refusals.parentArchived();
    return row;
  }

  private async item(tx: Transaction, id: string): Promise<FaqItemRow> {
    const [row] = await tx.select().from(faqItems).where(eq(faqItems.id, id));
    if (!row) throw refusals.notFound('FAQ question');
    return row;
  }
}

const sectionEntity = (row: FaqSectionRow) => ({ type: 'faq_section' as const, id: row.id });
const itemEntity = (row: FaqItemRow) => ({ type: 'faq_item' as const, id: row.id });

const itemValues = (row: FaqItemRow) => ({
  sectionId: row.sectionId,
  question: row.question,
  answerLength: row.answer.length,
});

function publicationOf(row: PublicationRow): FaqPublication {
  const sections = faqSnapshotSchema.parse(row.sections);
  return {
    revision: row.faqRevision,
    publishedAt: row.publishedAt.toISOString(),
    sections: sections.length,
    items: sections.reduce((total, section) => total + section.items.length, 0),
  };
}
