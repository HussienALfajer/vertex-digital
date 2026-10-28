import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CONTENT_PAGES,
  type ContentPage,
  type PageDraft,
  type PageSummary,
  type PageVersion,
  type PublishedPage,
  richTextProblems,
  type SavePageDraft,
} from '@vertex-digital/contracts';
import {
  contentPageDrafts,
  contentPageVersions,
  type Database,
  queueStoreRevalidate,
  type Transaction,
} from '@vertex-digital/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { JobsService } from '../../core/jobs/index.js';
import { type Actor, audit, PAGE_ENTITY_IDS, refusals } from './content-records.js';

type DraftRow = typeof contentPageDrafts.$inferSelect;
type VersionRow = typeof contentPageVersions.$inferSelect;
type Executor = Database | Transaction;

/**
 * The four fixed pages (S14 PG1–PG6): drafts saved in place under their revision, published as
 * append-only versions, and the store's reads of the newest version.
 */
@Injectable()
export class ContentPagesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
  ) {}

  /** `GET /api/admin/content/pages`: the four pages in their fixed order. */
  async summaries(): Promise<PageSummary[]> {
    const [drafts, newest] = await Promise.all([
      this.db.select().from(contentPageDrafts),
      this.newestVersions(this.db),
    ]);
    return CONTENT_PAGES.map((page) => {
      const draft = drafts.find((row) => row.page === page) as DraftRow;
      return summary(draft, newest.get(page) ?? null);
    });
  }

  /** `GET /api/admin/content/pages/:page`: the draft with its versions, newest first. */
  async draft(page: ContentPage, executor: Executor = this.db): Promise<PageDraft> {
    const [draft] = await executor
      .select()
      .from(contentPageDrafts)
      .where(eq(contentPageDrafts.page, page));
    if (!draft) throw refusals.notFound('page');
    const versions = await executor
      .select()
      .from(contentPageVersions)
      .where(eq(contentPageVersions.page, page))
      .orderBy(desc(contentPageVersions.version));
    return {
      ...summary(draft, versions[0] ?? null),
      body: draft.body,
      versions: versions.map((version) => ({
        version: version.version,
        title: version.title,
        publishedAt: version.publishedAt.toISOString(),
      })),
    };
  }

  /** `GET /api/admin/content/pages/:page/versions/:version`. */
  async version(page: ContentPage, version: number): Promise<PageVersion> {
    return toVersion(await this.findVersion(this.db, page, version));
  }

  /** Rule PG3: saved over the revision as last read; another tab's save first is `CONTENT_STALE`. */
  async saveDraft(actor: Actor, page: ContentPage, input: SavePageDraft): Promise<PageDraft> {
    return this.db.transaction(async (tx) => {
      const draft = await this.write(tx, page, input.revision, {
        title: input.title,
        body: input.body,
        updatedBy: actor.adminId,
      });
      await audit(
        tx,
        actor,
        'content_page.draft_saved',
        { type: 'content_page', id: PAGE_ENTITY_IDS[page] },
        { page, revision: draft.revision, title: draft.title, bodyLength: draft.body.length },
      );
      return this.draft(page, tx);
    });
  }

  /**
   * Rule PG5: the previewed revision becomes the next version, with its audit entry and the
   * store's refresh in the same transaction.
   */
  async publish(actor: Actor, page: ContentPage, revision: number): Promise<PageVersion> {
    return this.db.transaction(async (tx) => {
      const draft = await this.lockDraft(tx, page, revision);
      if (draft.body.trim() === '') {
        throw refusals.invalid(['body'], 'Expected a body to publish');
      }
      const problems = richTextProblems(draft.body);
      if (problems.length > 0) throw refusals.richText('body', problems);
      const [newest] = await tx
        .select()
        .from(contentPageVersions)
        .where(eq(contentPageVersions.page, page))
        .orderBy(desc(contentPageVersions.version))
        .limit(1);
      if (newest && newest.title === draft.title && newest.body === draft.body) {
        throw refusals.unchanged();
      }
      const [row] = await tx
        .insert(contentPageVersions)
        .values({
          page,
          version: (newest?.version ?? 0) + 1,
          title: draft.title,
          body: draft.body,
          draftRevision: draft.revision,
          adminId: actor.adminId,
        })
        .returning();
      const version = row as VersionRow;
      await audit(
        tx,
        actor,
        'content_page.published',
        { type: 'content_page', id: PAGE_ENTITY_IDS[page] },
        {
          page,
          version: version.version,
          title: version.title,
          bodyLength: version.body.length,
          bodySha256: createHash('sha256').update(version.body).digest('hex'),
        },
      );
      await queueStoreRevalidate(tx, this.jobs, 'content');
      return toVersion(version);
    });
  }

  /** Rule PG6: a version's title and body copied into the draft (a save); nothing published. */
  async restore(
    actor: Actor,
    page: ContentPage,
    version: number,
    revision: number,
  ): Promise<PageDraft> {
    return this.db.transaction(async (tx) => {
      const source = await this.findVersion(tx, page, version);
      const draft = await this.write(tx, page, revision, {
        title: source.title,
        body: source.body,
        updatedBy: actor.adminId,
      });
      await audit(
        tx,
        actor,
        'content_page.version_restored',
        { type: 'content_page', id: PAGE_ENTITY_IDS[page] },
        { page, version, revision: draft.revision },
      );
      return this.draft(page, tx);
    });
  }

  /** `GET /api/content/pages/:page` (PG2): the newest version; an unpublished page is not found. */
  async published(page: ContentPage): Promise<PublishedPage> {
    const newest = (await this.newestVersions(this.db)).get(page);
    if (!newest) throw refusals.notFound('page');
    return {
      page,
      title: newest.title,
      body: newest.body,
      version: newest.version,
      updatedAt: newest.publishedAt.toISOString(),
    };
  }

  /**
   * The published pages for the store's site content (SL1, TA1, SL4): titles and dates only, never
   * the bodies (audit A08-3).
   */
  async publishedTitles(): Promise<{ page: ContentPage; title: string; updatedAt: string }[]> {
    const rows = await this.db
      .selectDistinctOn([contentPageVersions.page], {
        page: contentPageVersions.page,
        title: contentPageVersions.title,
        publishedAt: contentPageVersions.publishedAt,
      })
      .from(contentPageVersions)
      .orderBy(contentPageVersions.page, desc(contentPageVersions.version));
    return CONTENT_PAGES.flatMap((page) => {
      const version = rows.find((row) => row.page === page);
      return version
        ? [{ page, title: version.title, updatedAt: version.publishedAt.toISOString() }]
        : [];
    });
  }

  private async newestVersions(executor: Executor): Promise<Map<ContentPage, VersionRow>> {
    const rows = await executor
      .selectDistinctOn([contentPageVersions.page])
      .from(contentPageVersions)
      .orderBy(contentPageVersions.page, desc(contentPageVersions.version));
    return new Map(rows.map((row) => [row.page, row]));
  }

  private async findVersion(executor: Executor, page: ContentPage, version: number) {
    const [row] = await executor
      .select()
      .from(contentPageVersions)
      .where(and(eq(contentPageVersions.page, page), eq(contentPageVersions.version, version)));
    if (!row) throw refusals.notFound('page version');
    return row;
  }

  private async lockDraft(tx: Transaction, page: ContentPage, revision: number) {
    const [draft] = await tx
      .select()
      .from(contentPageDrafts)
      .where(eq(contentPageDrafts.page, page))
      .for('update');
    if (!draft) throw refusals.notFound('page');
    if (draft.revision !== revision) throw refusals.stale();
    return draft;
  }

  /** A save over `revision`: the next revision, or `CONTENT_STALE`. */
  private async write(
    tx: Transaction,
    page: ContentPage,
    revision: number,
    values: { title: string; body: string; updatedBy: string },
  ): Promise<DraftRow> {
    await this.lockDraft(tx, page, revision);
    const [row] = await tx
      .update(contentPageDrafts)
      .set({
        ...values,
        revision: sql`${contentPageDrafts.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(contentPageDrafts.page, page))
      .returning();
    return row as DraftRow;
  }
}

function summary(draft: DraftRow, newest: VersionRow | null): PageSummary {
  return {
    page: draft.page,
    title: draft.title,
    revision: draft.revision,
    updatedAt: draft.updatedAt.toISOString(),
    latestVersion: newest && {
      version: newest.version,
      publishedAt: newest.publishedAt.toISOString(),
    },
    unpublishedChanges: newest
      ? newest.title !== draft.title || newest.body !== draft.body
      : draft.body.trim() !== '',
  };
}

function toVersion(row: VersionRow): PageVersion {
  return {
    page: row.page,
    version: row.version,
    title: row.title,
    body: row.body,
    draftRevision: row.draftRevision,
    publishedAt: row.publishedAt.toISOString(),
  };
}
