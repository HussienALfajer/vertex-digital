import { ANNOUNCEMENT_TONES, CONTENT_PAGES } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, id, timestamps } from './columns.js';
import { storedFiles } from './files.js';

/*
 * Store content (S14 F21), owned by the api `content` module: the four page drafts and their
 * published versions, the FAQ working copy and its publications, banners, announcements and the
 * content settings. Versions and publications are append-only (migration 0048); the rest is
 * archived, never deleted. Admin ids carry no foreign key, as `deposit_settings.admin_id`.
 */

export const contentPageEnum = pgEnum('content_page', CONTENT_PAGES);

export const announcementToneEnum = pgEnum('announcement_tone', ANNOUNCEMENT_TONES);

/** MD4, the same pattern as `linkPathSchema`; `..` segments are refused by a second check. */
const LINK_PATH = `^/([A-Za-z0-9._~/-]*)?(#[A-Za-z0-9_-]+)?$`;

const linkPathCheck = (name: string, column: unknown) =>
  check(
    name,
    sql`${column} is null or (char_length(${column}) <= 200 and ${column} ~ ${sql.raw(`'${LINK_PATH}'`)} and ${column} !~ '^//' and ${column} !~ '(^|/)\\.\\.(/|#|$)')`,
  );

/** One row per page, seeded (PG1); a save updates it in place and increments `revision` (PG3). */
export const contentPageDrafts = pgTable(
  'content_page_drafts',
  {
    page: contentPageEnum('page').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    revision: integer('revision').notNull().default(0),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('content_page_drafts_title_check', sql`char_length(${table.title}) between 2 and 80`),
    check('content_page_drafts_body_check', sql`char_length(${table.body}) <= 30000`),
    check('content_page_drafts_revision_check', sql`${table.revision} >= 0`),
  ],
);

/** Append-only (PG5): a page is published once it has a version; the newest is shown. */
export const contentPageVersions = pgTable(
  'content_page_versions',
  {
    id: id(),
    page: contentPageEnum('page').notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    draftRevision: integer('draft_revision').notNull(),
    adminId: uuid('admin_id').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    uniqueIndex('content_page_versions_page_version_idx').on(table.page, table.version.desc()),
    check('content_page_versions_version_check', sql`${table.version} >= 1`),
    check('content_page_versions_title_check', sql`char_length(${table.title}) between 2 and 80`),
    check('content_page_versions_body_check', sql`char_length(${table.body}) between 1 and 30000`),
  ],
);

export const faqSections = pgTable(
  'faq_sections',
  {
    id: id(),
    title: text('title').notNull(),
    position: integer('position').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [check('faq_sections_title_check', sql`char_length(${table.title}) between 2 and 60`)],
);

export const faqItems = pgTable(
  'faq_items',
  {
    id: id(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => faqSections.id),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    position: integer('position').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    index('faq_items_section_id_position_idx').on(table.sectionId, table.position),
    check('faq_items_question_check', sql`char_length(${table.question}) between 5 and 200`),
    check('faq_items_answer_check', sql`char_length(${table.answer}) between 1 and 3000`),
  ],
);

/** Append-only (FQ5, FQ6): the FAQ as published, the newest is shown. */
export const faqPublications = pgTable(
  'faq_publications',
  {
    id: id(),
    faqRevision: integer('faq_revision').notNull(),
    /** `[{ id, title, items: [{ id, question, answer }] }]` in order (`faqSnapshotSchema`). */
    sections: jsonb('sections').notNull(),
    adminId: uuid('admin_id').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('faq_publications_published_at_idx').on(table.publishedAt.desc()),
    check('faq_publications_sections_check', sql`jsonb_typeof(${table.sections}) = 'array'`),
  ],
);

const schedule = {
  linkPath: text('link_path'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  enabled: boolean('enabled').notNull().default(false),
};

export const banners = pgTable(
  'banners',
  {
    id: id(),
    imageFileId: uuid('image_file_id')
      .notNull()
      .references(() => storedFiles.id),
    altText: text('alt_text').notNull(),
    ...schedule,
    position: integer('position').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    index('banners_image_file_id_idx').on(table.imageFileId),
    check('banners_alt_text_check', sql`char_length(${table.altText}) between 2 and 120`),
    check(
      'banners_schedule_check',
      sql`${table.startsAt} is null or ${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      'banners_archived_check',
      sql`not (${table.enabled} and ${table.archivedAt} is not null)`,
    ),
    linkPathCheck('banners_link_path_check', table.linkPath),
  ],
);

export const announcements = pgTable(
  'announcements',
  {
    id: id(),
    text: text('text').notNull(),
    tone: announcementToneEnum('tone').notNull().default('info'),
    ...schedule,
    /** +1 when the text, link or tone changes (AN4): a dismissed bar shows again. */
    revision: integer('revision').notNull().default(1),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    // AN2: at most one enabled announcement.
    uniqueIndex('announcements_one_enabled_idx')
      .on(table.enabled)
      .where(sql`${table.enabled} and ${table.archivedAt} is null`),
    check('announcements_text_check', sql`char_length(${table.text}) between 5 and 140`),
    check('announcements_revision_check', sql`${table.revision} >= 1`),
    check(
      'announcements_schedule_check',
      sql`${table.startsAt} is null or ${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      'announcements_archived_check',
      sql`not (${table.enabled} and ${table.archivedAt} is not null)`,
    ),
    linkPathCheck('announcements_link_path_check', table.linkPath),
  ],
);

/** One row, seeded (LA6, FQ6). */
export const contentSettings = pgTable(
  'content_settings',
  {
    id: integer('id').primaryKey(),
    liveActivityEnabled: boolean('live_activity_enabled').notNull().default(true),
    faqRevision: integer('faq_revision').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('content_settings_one_row_check', sql`${table.id} = 1`),
    check('content_settings_faq_revision_check', sql`${table.faqRevision} >= 0`),
  ],
);
